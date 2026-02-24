const dotenv = require('dotenv')
const SFTPClient = require('./utils/sftp')
const fs = require('fs').promises
const Papa = require('papaparse')
dotenv.config()

exports.handler = async (event, context) => {
  const client = new SFTPClient()
  await client.connect()

  const pathInventory = './MuleSoftFTP/sfcc/prod/product2'
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
    const processFilePath = `${processInventory}/${csv}`
    const originalFilePath = `${pathInventory}/${csv}`

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

    // Read the file content as a Buffer
    const fileBuffer = await fs.readFile(readFile)
    const fileContent = fileBuffer.toString('utf-8')

    // Parse the CSV file using papaparse
    const parsedData = Papa.parse(fileContent, {
      header: true,
      dynamicTyping: false,
      transformHeader: header => header.trim(),
      transform: (value, header) => (header === 'MATNR' ? value : value)
    })

    let typedData = parsedData.data
    let processedDataCount = 0
    const batchSize = 10

    while (typedData.length > 0) {
      // Process records
      const batch = typedData.splice(0, batchSize)

      for (const element of batch) {
        console.log(element.MATNR)
        /* Get Product ID */
        const url1 = `${process.env.SHOPIFY_URL}/admin/api/2024-07/products.json?handle=${element.MATNR}`

        const res1 = await fetch(url1, {
          method: 'get',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN
          }
        })
        const result1 = await res1.json()
        /* Get Product ID */

        await new Promise(resolve => setTimeout(resolve, 120))

        if (result1.products.length > 0) {
          await metadata(element, result1.products[0].id)
          await new Promise(resolve => setTimeout(resolve, 120))
        }

        /* Add New All Image */
      }

      processedDataCount += batch.length

      // Write remaining data to a new file if needed
      if (typedData.length > 0) {
        const processedFileContent = Papa.unparse(typedData, {
          header: true,
          skipEmptyLines: true
        })
        await fs.writeFile(localProcessFile, processedFileContent)

        // Upload processed file to "process" folder
        const remoteUploadFile = `${processInventory}/${csv}`

        await client.uploadFile(localProcessFile, remoteUploadFile)
      }
    }

    // Upload the original file to the "archived" folder
    console.log('Download Again Original File')
    await client.downloadFile(originalFilePath, localFile)
    const remoteUploadFile = `./MuleSoftFTP/sfcc/prod/archived/product2/${csv}`
    await client.uploadFile(localFile, remoteUploadFile)

    // Delete remote file
    await client.deleteFileLocal(localProcessFile)
    await client.deleteFileRemote(processFilePath)
    await client.deleteFileLocal(localFile)
    await client.deleteFileRemote(originalFilePath)
  }

  // Close the connection
  await client.disconnect()

  return 'done'
}

async function metadata (chunk, product_id) {
  const url3 = `${process.env.SHOPIFY_URL}/admin/api/2024-01/products/${product_id}/metafields.json`
  const res3 = await fetch(url3, {
    method: 'get',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN ?? ''
    }
  })
  const json3 = await res3.json()

  await new Promise(resolve => setTimeout(resolve, 120))

  /* metadata */
  const metadata = [
    {
      namespace: 'custom',
      key: 'expiry_date',
      type: 'date',
      sfcc: 'expiryDate'
    }
  ]

  for (const meta of metadata) {
    const data = json3.metafields.find(field => field.key === meta.key)

    let met, md

    md = chunk.EXPIRY ? chunk.EXPIRY : null

    if (data && md) {
      if (!md) {
        const url3 = `${process.env.SHOPIFY_URL}/admin/api/2024-07/products/${product_id}/metafields/${data.id}.json`

        const res3 = await fetch(url3, {
          method: 'delete',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN ?? ''
          }
        })

        met = await res3.json()

        await new Promise(resolve => setTimeout(resolve, 120))

        console.log(
          'Product',
          'Delete Metadata ' + meta.key + ' :' + JSON.stringify(met)
        )
      } else {
        const data = json3.metafields.find(field => field.key === meta.key)

        console.log('Check value', data.value, md)
        if (data.value == md) {
          console.log('Exit Loop')

          return
        }

        const body2 = JSON.stringify({
          metafield: {
            id: data.id,
            value: md,
            type: meta.type
          }
        })

        console.log(body2)

        const url3 = `${process.env.SHOPIFY_URL}/admin/api/2024-07/products/${product_id}/metafields/${data.id}.json`

        const res3 = await fetch(url3, {
          method: 'put',
          body: body2,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN ?? ''
          }
        })

        met = await res3.json()

        await new Promise(resolve => setTimeout(resolve, 120))

        console.log(
          'Product',
          'Update Metadata ' + meta.key + ' :' + JSON.stringify(met)
        )
      }
    } else if (!data && md) {
      if (md) {
        const url3 = `${process.env.SHOPIFY_URL}/admin/api/2024-07/products/${product_id}/metafields.json`

        const body2 = JSON.stringify({
          metafield: {
            namespace: meta.namespace,
            key: meta.key, // Updated this line to use meta.shopify
            value: md,
            type: meta.type
          }
        })

        console.log(body2)

        const res3 = await fetch(url3, {
          method: 'post',
          body: body2,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN ?? ''
          }
        })

        met = await res3.json()

        console.log(
          'Product',
          'Success Metadata ' + meta.key + ' :' + JSON.stringify(met)
        )
      }
    }

    await new Promise(resolve => setTimeout(resolve, 120))
  }
}
