const Client = require('ssh2-sftp-client')
const fs = require('fs/promises')
const dotenv = require('dotenv')
const path = require('path')

class SFTPClient {
  constructor () {
    this.client = new Client()
  }

  async connect () {
    const options = {
      host: process.env.SFTP_HOST,
      port: process.env.SFTP_PORT,
      username: process.env.SFTP_USERNAME,
      password: process.env.SFTP_PASSWORD
    }

    console.log(`Connecting to ${options.host}:${options.port}`)
    try {
      await this.client.connect(options)
    } catch (err) {
      console.log('Error: Failed to connect: ' + err)
    }
  }

  async disconnect () {
    await this.client.end()
  }

  async listFiles (remoteDir, fileGlob) {
    console.log(`Listing ${remoteDir} ...`)
    let fileObjects
    try {
      fileObjects = await this.client.list(remoteDir, fileGlob)

      const files = fileObjects.filter(item => !item.type || item.type === '-')

      // Return only files
      return files.map(file => file.name)
    } catch (err) {
      console.log('Error Listing failed: ' + err)
    }

    const fileNames = []

    for (const file of fileObjects) {
      if (file.type === 'd') {
        console.log(
          `${new Date(file.modifyTime).toISOString()} PRE ${file.name}`
        )
      } else {
        console.log(
          `${new Date(file.modifyTime).toISOString()} ${file.size} ${file.name}`
        )
      }

      fileNames.push(file.name)
    }

    return fileNames
  }

  async uploadFile (localFile, remoteFile) {
    console.log(`Uploading ${localFile} to ${remoteFile} ...`)
    try {
      await this.client.put(localFile, remoteFile)
    } catch (err) {
      console.error('Error Uploading failed:', err)
    }
  }

  async downloadFile (remoteFile, localFile) {
    console.log(`Downloading ${remoteFile} to ${localFile} ...`)
    try {
      await this.client.get(remoteFile, localFile)
    } catch (err) {
      console.error('Error Downloading failed:', err)
    }
  }

  async deleteFileLocal (file) {
    console.log(`Deleting Local ${file}`)

    try {
      const resolvedPath = path.resolve(file) // Resolve the absolute path
      console.log(`Checking existence of local file: ${resolvedPath}`)

      // Check if the file exists
      try {
        await fs.access(resolvedPath) // File exists
      } catch (err) {
        if (err.code === 'ENOENT') {
          console.log(`File does not exist: ${resolvedPath}`)
          return // Exit function if file doesn't exist
        } else {
          throw err // If there's another error, re-throw it
        }
      }

      console.log(`Deleting local file: ${resolvedPath}`)

      // File exists, proceed to delete
      await fs.unlink(resolvedPath)

      console.log(`File deleted successfully: ${resolvedPath}`)
    } catch (err) {
      console.error('Error Deleting failed:', err)
    }
  }

  async deleteFileRemote (file) {
    console.log(`Deleting SFTP ${file}`)
    try {
      const result = await this.fileExists(file)

      if (result) await this.client.delete(file)
    } catch (err) {
      console.error('Error Deleting failed:', err)
    }
  }

  async fileExists (filePath) {
    console.log(`Checking if file exists: ${filePath}`)

    try {
      // Get list of files in the directory of the given file path
      const fileList = await this.client.list(path.dirname(filePath))
      return fileList.some(file => file.name === path.basename(filePath))
    } catch (error) {
      console.log(`Error checking file existence: ${error.message}`)
      return false // Return false if there's an error
    }
  }

  async createSftpDirectory (dirPath) {
    try {
      // Check if the directory exists on the SFTP server
      const directoryExists = await this.client.exists(dirPath)

      if (!directoryExists) {
        // Create the directory if it doesn't exist
        await this.client.mkdir(dirPath, { recursive: true })
        console.log(`Directory created: ${dirPath}`)
      } else {
        console.log(`Directory already exists: ${dirPath}`)
      }
    } catch (error) {
      console.log(`Error: Failed to create directory '${dirPath}':`)
    }
  }
}

module.exports = SFTPClient
