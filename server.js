const dotenv = require('dotenv')
const SFTPClient = require('./utils/sftp')
const fs = require('fs').promises
const Papa = require('papaparse')
const path = require('path')

dotenv.config()

const fastify = require('fastify')({ logger: true })
const url1 = `${process.env.SHOPIFY_URL}/admin/api/2026-01/graphql.json`

fastify.post('/api/expiredDate', async (request, reply) => {
  const client = new SFTPClient()
  await client.connect()

  const pathInventory = './MuleSoftFTP/sfcc/dev/product2'
  const processInventory = `${pathInventory}/process`
  let csvs = await client.listFiles(pathInventory)

  csvs = csvs.filter(file => file.includes('ProductExpiryClearance'))

  const localDir = '/tmp/iDoc'
  try {
    await fs.access(localDir) // Check if directory exists
  } catch (error) {
    await fs.mkdir(localDir, { recursive: true }) // Create directory if it doesn't exist
  }

  const localProcessDir = `${localDir}/process`

  try {
    await fs.access(localProcessDir) // Check if directory exists
  } catch (error) {
    await fs.mkdir(localProcessDir, { recursive: true }) // Create directory if it doesn't exist
  }

  await client.createSftpDirectory(processInventory)

  for (const csv of csvs) {
    let remoteFile, readFile

    const jsonFileName = csv.replace(/\.csv$/i, '.json')
    const processFilePath = `${processInventory}/${jsonFileName}`
    const originalFilePath = `${pathInventory}/${csv}`
    const remoteJsonFile = `${processInventory}/${jsonFileName}`

    const result = await client.fileExists(processFilePath)
    const localFile = `${localDir}/${csv}`
    const localProcessFile = `${localProcessDir}/${csv}`

    // Check if file exists in the process directory
    if (result) {
      await client.downloadFile(processFilePath, localProcessFile)
      readFile = localProcessFile
      remoteFile = processFilePath
    } else {
      await client.downloadFile(originalFilePath, localFile)
      readFile = localFile
      remoteFile = originalFilePath
    }

    const extension = path.extname(remoteFile).toLowerCase()
    let jsondData

    // ============================
    // CASE 1: CSV → convert + upload JSON
    // ============================
    if (extension === '.csv') {
      const fileContent = await fs.readFile(readFile, 'utf-8')

      const parsedData = Papa.parse(fileContent, {
        header: true,
        transformHeader: header => header.trim()
      })

      // Group by MATNR
      const grouped = parsedData.data.reduce((acc, row) => {
        if (!row.MATNR) return acc

        if (!acc[row.MATNR]) {
          acc[row.MATNR] = { MATNR: row.MATNR, ITEMS: [] }
        }

        acc[row.MATNR].ITEMS.push({
          EXPIRY: row.EXPIRY,
          STOCK: row.STOCK
        })

        return acc
      }, {})

      jsondData = Object.values(grouped)

      // Save JSON locally

      await fs.writeFile(localFile, JSON.stringify(jsondData, null, 2))

      // Upload JSON to processInventory

      await client.uploadFile(localFile, remoteJsonFile)
    }

    // ============================
    // CASE 2: JSON → just read
    // ============================
    else if (extension === '.json') {
      const fileContent = await fs.readFile(readFile, 'utf-8')
      jsondData = JSON.parse(fileContent)
    }

    let processedDataCount = 0
    const batchSize = 10

    while (jsondData.length > 0) {
      // Process records
      const batch = jsondData.splice(0, batchSize)
      await new Promise(resolve => setTimeout(resolve, 3000))

      for (const element of batch) {
        console.log(element)

        const body1 = JSON.stringify({
          query: `query { productByHandle(handle: "${element.MATNR}") { id title productType description vendor } }`
        })

        const res1 = await fetch(url1, {
          method: 'post',
          body: body1,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN
          }
        })
        const result1 = await res1.json()
        /* Get Product ID */

        await new Promise(resolve => setTimeout(resolve, 120))

        if (result1.data?.productByHandle) {
          // Extract only the EXPIRY values into a plain array
          const expiryDates = element.ITEMS.map(item => item.EXPIRY)

          const body2 = {
            query:
              'mutation UpdateProductWithNewMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) { productUpdate(product: $product, media: $media) { product { id tags media(first: 10) { nodes { alt mediaContentType preview { status } } } } userErrors { field message } } }',
            variables: {
              product: {
                id: result1.data.productByHandle.id,
                metafields: [
                  {
                    namespace: 'custom',
                    key: 'expiry_date_v2',
                    value: JSON.stringify(expiryDates),
                    type: 'list.date'
                  }
                ]
              }
            }
          }

          const res3 = await fetch(url1, {
            method: 'post',
            body: JSON.stringify(body2),
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN || ''
            }
          })

          await res3.json()
        }

        /* Add New All Image */
      }

      processedDataCount += batch.length

      // Write remaining data to a new file if needed
      if (jsondData.length > 0) {
        const batchMatnrSet = new Set(batch.map(item => item.MATNR))

        jsondData = jsondData.filter(item => !batchMatnrSet.has(item.MATNR))

        await fs.writeFile(localFile, JSON.stringify(jsondData, null, 2))

        // Upload JSON to processInventory

        await client.uploadFile(localFile, remoteJsonFile)
      }
    }

    // Upload the original file to the "archived" folder
    console.log('Download Again Original File')
    await client.downloadFile(originalFilePath, localFile)
    const remoteUploadFile = `./MuleSoftFTP/sfcc/prod/archived/product2/${csv}`
    await client.uploadFile(localFile, remoteUploadFile)

    // Delete remote file
    await client.deleteFileLocal(localProcessFile)
    await client.deleteFileRemote(remoteJsonFile)
    await client.deleteFileLocal(localFile)
    await client.deleteFileRemote(originalFilePath)
  }

  // Close the connection
  await client.disconnect()

  return 'done'
})

fastify.listen({ port: 3021 }, err => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
