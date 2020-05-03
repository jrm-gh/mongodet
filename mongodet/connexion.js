'use strict'
// 
const { MongoClient } = require('mongodb')

const EventEmitter = require('events')
class ConnectionEmitter extends EventEmitter {}
const connectionEmitter = new ConnectionEmitter()

let client = new MongoClient()
let connectionStatus = ''

async function connect(url, options) {
    client = new MongoClient(url, options)
    const r = await client.connect()
    connectionStatus = 'connected'
    connectionEmitter.emit('connected')
    return r
}

async function disconnect() {
    await client.close()
    connectionStatus = 'disconnected'
    connectionEmitter.emit('disconnected')
    client = null
}

function getClient() {
    return client
}

function getConnectionStatus() {
    return connectionStatus
}

module.exports = {
    connect,
    disconnect,
    getClient,
    getConnectionStatus,
    connectionEmitter
}
