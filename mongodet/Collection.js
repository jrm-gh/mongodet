'use strict'

const { Cursor } = require('mongodb') // Required to show the Cursor methods in the IDE.
const { ObjectId, Decimal128, Int32, Long } = require('mongodb') // To export types

const {
    getClient,
    connectionEmitter,
    getConnectionStatus
} = require('./connexion')

const conversion = require('./conversion')
const { MongolError } = require('./errors')

const {
    validateDocument,
    getValidationData
} = require('./Collection/validateDocument')

const EventEmitter = require('events')

class Collection {
    /**
     * @function
     * @param {string} [name] The name of this class. Note if that an instance with this name has been already
     * @param {object} [parameters={}] A set of parameters required to build an instance of this class.
     * @param {object} [parameters.schema] An object defining a JSON schema.
     * @param {object} [parameter.indexes] An object defining the indexes. The key will be the name of the index, and the value is the set of parameters passed to the createIndex() function.
     * @param {object} [parameter.methods] An object defining the methods to append to the instance of this class. An object is a better than array option because you can easily change the function name of each element.
     * @param {object} [parameter.settings] An object defining the settings of this collection. Contains all the parameters (capped, size ...) required to build it.
     * @param {object} [parameter.properties] An object containing several options.
     * @param {object} [parameter.properties.dropCollection=false] If set to true, the collection will be dropped.
     * @param {object} [parameter.properties.createCollection=false] If set to true, the collection will be created with the parameter "settings" passed to the constructor. The collection is dropped (only if requested) before creating it.
     * @param {object} [parameter.properties.dropIndexes=false] If set to true, all the indexes defined in "parameters.indexes" will be removed.
     * @param {object} [parameter.properties.createIndexes=false] If set to true, all the indexes defined in "parameters.indexes" will be created. Note that if the option "dropIndexes" is also set, indexes will be removed before creating them.
     * @param {object} [parameter.properties.printInitializationData=false] If set to true, several initialization messages will be printed to the standard output.
     * @param {object[function]} [parameters.methods={}] An object containing methods that will be added to the instance of this class.
     */
    constructor(name, parameters = {}) {
        if (Collection.collections[name]) {
            console.log(
                `An instance of Collection class called "${name}" exists. Sending its reference instead of creating a new instance.`
            )
            return Collection.collections[name]
        }

        if (!parameters.schema) parameters.schema = {}
        if (!parameters.indexes) parameters.indexes = {}
        if (!parameters.methods) parameters.methods = {}
        if (!parameters.properties) parameters.properties = {}

        this.name = name
        this.parameters = parameters
        this.eventEmitter = new EventEmitter()

        connectionEmitter.on('connected', this.bindCollection.bind(this))
        if (getConnectionStatus() === 'connected') this.bindCollection()

        for (let f in parameters.methods)
            if (parameters.methods.hasOwnProperty)
                this[f] = parameters.methods[f].bind(this)

        Collection.collections[name] = this
        this.validationData = getValidationData(this.parameters.schema)
        this.types = { ObjectId, Decimal128, Int32, Long }
    }

    async bindCollection() {
        const client = getClient()

        const p = this.name.split(' ') // ('#')

        this.collName = p.pop()
        this.dbName = p.pop() || client.db().databaseName
        this.db = client.db(this.dbName)
        this.collection = client.db(this.dbName).collection(this.collName)

        let collectionExists = false
        const collections = await this.db.collections()
        for (let i = 0; i < collections.length; i++) {
            if (
                collections[i].namespace === `${this.dbName}.${this.collName}`
            ) {
                collectionExists = true
                break
            }
        }

        if (!collectionExists) {
            if (this.parameters.properties.printInitializationData)
                console.log(
                    `Collection "${this.dbName}.${this.collName}" doest not exist.` +
                        'Creating it and its indexes.'
                )
            await this.createCollection()
            await this.createIndexes()
        } else {
            // Creating tables and indexes (if requested)
            if (this.parameters.properties.dropCollection)
                await this.dropCollection()

            if (this.parameters.properties.createCollection)
                await this.createCollection()

            if (this.parameters.properties.createIndexes)
                await this.dropIndexes()

            if (this.parameters.properties.createIndexes)
                await this.createIndexes()
        }

        this.eventEmitter.emit('collection-bound')
        this.collectionBound = true
    }

    async createCollection() {
        if (!this.db) {
            console.error(
                'The database can not be created because you are not connected to the server.'
            )
            return
        }

        if (this.parameters.properties.printInitializationData)
            console.log(`Creating collection "${this.dbName}.${this.collName}"`)
        await this.db.createCollection(this.collName, this.parameters.settings)
    }

    async dropCollection() {
        if (!this.db) {
            console.error(
                'The database can not be dropped because you are not connected to the server.'
            )
            return
        }
        if (this.parameters.properties.printInitializationData)
            console.log(`Dropping collection "${this.dbName}.${this.collName}"`)
        try {
            await this.drop()
        } catch (e) {
            console.log(
                `Error dropping collection "${this.dbName}.${this.collName}"`
            )
            console.log(e)
        }
    }

    /**
     * This function waits until the collection is initialized.
     * @returns This function returns a promise with no data. It will be resolved when the collection and indexes has been created.
     */
    async waitForInitializaton() {
        return new Promise((resolve) => {
            if (this.collectionBound) return resolve()
            this.eventEmitter.on('collection-bound', resolve)
        })
    }

    /**
     * This function sleeps for the specified amount of time.
     * @param {number} s The amount of time to sleep, in seconds.
     */
    async sleep(s) {
        return new Promise((resolve) => setTimeout(resolve, s * 1000))
    }

    /**
     * This function:
     * - Creates all the indexes specified for this collection by the "indexes" parameter if no parameter is passed to this function.
     * - Calls the original function createIndexes(), as specified in https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#createIndexes
     */
    async createIndexes(indexSpecs, options, callback) {
        if (!this.db) {
            console.error(
                'Indexes can not be created because you are not connected to the server.'
            )
            return
        }

        if (this.parameters.properties.printInitializationData)
            console.log(
                `Creating indexes for collection "${this.dbName}.${this.collName}"`
            )

        if (indexSpecs)
            return this.collection.createIndexes(indexSpecs, options, callback)

        if (this.parameters.indexes) {
            for (let indexName in this.parameters.indexes) {
                if (
                    Object.prototype.hasOwnProperty.call(
                        this.parameters.indexes,
                        indexName
                    )
                ) {
                    if (this.parameters.properties.printInitializationData)
                        console.log(`\tCreating index ${indexName}`)
                    let ixp = this.parameters.indexes[indexName]
                    if (ixp.constructor.name === 'Object') ixp = [ixp, {}]
                    ixp[1].name = indexName
                    await this.collection.createIndex(ixp[0], ixp[1])
                }
            }
        }
    }

    dummy() {
        return new Cursor()
    } // To avoid a jshint warning.

    /**
     * This function validate the specified document.
     * @param {object} data - A single document or an array of documents to validate.
     * @param {string} [mode='update'] - The mode on which data will be updated. Valid values are 'insert' and 'update'.
     */
    validateDocument(data, mode = 'update') {
        return validateDocument(data, this.validationData[mode].validator)
    }

    documentToDbFormat(doc) {
        return conversion.documentToDbFormat(
            doc,
            this.parameters.schema,
            this.validator
        )
    }
    dbFormatToDocument(doc) {
        return conversion.dbFormatToDocument(doc, this.parameters.schema)
    }
}

Collection.collections = {}
Collection.getCollections = function () {
    return Collection.collections
}

module.exports = { Collection }

////////////////////////////////////////////////////////////////////////////////
// Redefined mongodb methods.
////////////////////////////////////////////////////////////////////////////////

// FUNCTION                        PARAMETERS                  RETURNS     NOTES
//
// insertOne()  / insertMany()              doc      options   JDITR
// findOne()    / findMany()       query             options   JD          N1
// replaceOne()                    filter   doc      options   (N)R        N2
// updateOne()  / updateMany()     filter   update   options   (N)R
// deleteOne()  / deleteMany()     filter            options   (N)R
//
// findOneAndReplace()             filter   replace  options   (J)DNR      N3
// findOneAndUpdate()              filter   update   options   (J)DNR      N3
// findOneAndDelete()              filter            options   (J)DNR      N3

// All the functions that take a **doc** or **replace** parameter can take the
// optional parameter 'input', and can be set to one of the following values:
// - 'json' (default value): to convert the input parameter **doc** or **replace**
// to db format.
// - 'db': no conversion is done.

// Return values (specified by the parameter 'output'):
// J ('json'): data in JSON format (converted from database format).
// D ('db'): data in database format.
// I ('id'): id of the inserted element(s).
// T ('idText'): id of the inserted element(s), converted to text.
// N ('nb'): number of modified elements.
// R ('raw'): raw (whole) response received from the server.

// Notes:
// - N1: the new function findMany() calls to "toArray()" function. The original mongodb function find() has not been changed.
// - N2: J and D options have been removed intentionnaly on the mongodet library beacause they are not useful.
// - N3: JD options return the document stored before calling this function.

// Adding other mongodb methods, based on:
// http://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#findOne
// https://github.com/mongodb/node-mongodb-native/blob/master/lib/collection.js

/**
 * Inserts a single document into MongoDB. If documents passed in do not contain the **_id** field,
 * one will be added to each of the documents missing it by the driver, mutating the document. This behavior
 * can be overridden by setting the **forceServerObjectId** flag.
 *
 * See original function
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#insertOne
 * @function
 * @param {object} doc Document to insert.
 * @param {object} [options] Optional settings.
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {boolean} [options.forceServerObjectId=false] Force server to assign _id values instead of driver.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.checkKeys=true] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {string} [options.output='json'] This optional mongodet specific parameter determines the type of the data returned by this function. Valid values and data returned are:
 * - **'json'**: returns the data written to the database, converted to JSON format.
 * - **'db'**: returns the data written to the database.
 * - **'id'**: returns the id of the written element.
 * - **'idText'**: returns the id of the written element, in text format (using the .toString() function).
 * - **'raw'**: returns the whole response received from the server.
 * @returns {Promise} returns a Promise. If resolved, it will send the data specified by the **output** parameter.
 */
Collection.prototype.insertOne = function (doc, options) {
    let output = 'json',
        outputFilter

    if (options && options.output) {
        output = options.output
        delete options.output
    }

    switch (output) {
        case 'json':
            outputFilter = (r) => this.dbFormatToDocument(r.ops[0])
            break
        case 'db':
            outputFilter = (r) => conversion.equal(r.ops[0])
            break
        case 'id':
            outputFilter = (r) => conversion.equal(r.insertedId)
            break
        case 'idText':
            outputFilter = (r) => conversion.equal(r.insertedId.toString())
            break
        case 'raw':
            outputFilter = conversion.equal
            break
        default:
            throw new MongolError(`Incorrect output parameter "${output}"`)
    }

    outputFilter = outputFilter.bind(this)

    return this.collection.insertOne(doc).then((d) => outputFilter(d))
}

/**
 * Inserts an array of documents into MongoDB. If documents passed in do not contain the **_id** field,
 * one will be added to each of the documents missing it by the driver, mutating the document. This behavior
 * can be overridden by setting the **forceServerObjectId** flag.
 *
 * See original function
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#insertMany
 * @function
 * @param {object[]} docs Documents to insert.
 * @param {object} [options] Optional settings.
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {boolean} [options.ordered=true] If true, when an insert fails, don't execute the remaining writes. If false, continue with remaining inserts when one fails.
 * @param {boolean} [options.forceServerObjectId=false] Force server to assign _id values instead of driver.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.checkKeys=true] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {string} [options.output='json'] This optional mongodet specific parameter determines the type of the data returned by this function. Valid values and data returned are:
 * - **'json'**: returns the data written to the database, converted to JSON format.
 * - **'db'**: returns the data written to the database.
 * - **'id'**: returns the id(s) of the written element(s).
 * - **'idText'**: returns the id(s) of the written element(s), in text format (using the .toString() function).
 * - **'raw'**: returns the whole response received from the server.
 * @returns {Promise} returns a Promise. If resolved, it will send the data specified by the **output** parameter.
 */
Collection.prototype.insertMany = function (docs, options) {
    let output = 'json',
        outputFilter

    if (options && options.output) {
        output = options.output
        delete options.output
    }

    switch (output) {
        case 'json':
            outputFilter = (r) => this.dbFormatToDocument(r.ops)
            break
        case 'db':
            outputFilter = (r) => conversion.equal(r.ops)
            break
        case 'id':
            outputFilter = (r) => conversion.equal(Object.values(r.insertedIds))
            break
        case 'idText':
            outputFilter = (r) =>
                conversion.equal(
                    Object.values(r.insertedIds).map((v) => v.toString())
                )
            break
        case 'raw':
            outputFilter = conversion.equal
            break
        default:
            throw new MongolError({
                error: `Incorrect output parameter "${output}"`
            })
    }

    outputFilter = outputFilter.bind(this)

    return this.collection.insertMany(docs).then((d) => outputFilter(d))
}

/**
 * Fetches the first document that matches the query
 *
 * See original function
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#findOne
 * @function
 * @param {object} query Query for find Operation
 * @param {object} [options] Optional settings.
 * @param {number} [options.limit=0] Sets the limit of documents returned in the query.
 * @param {(Array|object)} [options.sort] Set to sort the documents coming back from the query. Array of indexes, [['a', 1]] etc.
 * @param {object} [options.projection] The fields to return in the query. Object of fields to include or exclude (not both), {'a':1}
 * @param {object} [options.fields] **Deprecated** Use `options.projection` instead
 * @param {number} [options.skip=0] Set to skip N documents ahead in your query (useful for pagination).
 * @param {object} [options.hint] Tell the query to use specific indexes in the query. Object of indexes to use, {'_id':1}
 * @param {boolean} [options.explain=false] Explain the query instead of returning the data.
 * @param {boolean} [options.snapshot=false] DEPRECATED: Snapshot query.
 * @param {boolean} [options.timeout=false] Specify if the cursor can timeout.
 * @param {boolean} [options.tailable=false] Specify if the cursor is tailable.
 * @param {number} [options.batchSize=1] Set the batchSize for the getMoreCommand when iterating over the query results.
 * @param {boolean} [options.returnKey=false] Only return the index key.
 * @param {number} [options.maxScan] DEPRECATED: Limit the number of items to scan.
 * @param {number} [options.min] Set index bounds.
 * @param {number} [options.max] Set index bounds.
 * @param {boolean} [options.showDiskLoc=false] Show disk location of results.
 * @param {string} [options.comment] You can put a $comment field on a query to make looking in the profiler logs simpler.
 * @param {boolean} [options.raw=false] Return document results as raw BSON buffers.
 * @param {boolean} [options.promoteLongs=true] Promotes Long values to number if they fit inside the 53 bits resolution.
 * @param {boolean} [options.promoteValues=true] Promotes BSON values to native types where possible, set to false to only receive wrapper types.
 * @param {boolean} [options.promoteBuffers=false] Promotes Binary BSON values to native Node Buffers.
 * @param {(ReadPreference|string)} [options.readPreference] The preferred read preference (ReadPreference.PRIMARY, ReadPreference.PRIMARY_PREFERRED, ReadPreference.SECONDARY, ReadPreference.SECONDARY_PREFERRED, ReadPreference.NEAREST).
 * @param {boolean} [options.partial=false] Specify if the cursor should return partial results when querying against a sharded system
 * @param {number} [options.maxTimeMS] Number of milliseconds to wait before aborting the query.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {string} [options.output='json'] This optional mongodet specific parameter determines the type of the data returned by this function. Valid values and data returned are:
 * - **'json'**: returns matching document(s), converted to a JSON object using the schema associated to this collection.
 * - **'db'**: returns the matching document(s), as returned by the server.
 * @returns {Promise} returns a Promise. If resolved, it will send the data read from the database.
 */
Collection.prototype.findOne = function (query, options) {
    let output = 'json',
        outputFilter

    if (options && options.output) {
        output = options.output
        delete options.output
    }

    switch (output) {
        case 'json':
            outputFilter = (r) => this.dbFormatToDocument(r)
            break
        case 'db':
            outputFilter = (r) => conversion.equal(r)
            break
        default:
            throw new MongolError({
                error: `Incorrect output parameter "${output}"`
            })
    }

    outputFilter = outputFilter.bind(this)

    return this.collection.findOne(query, options).then((d) => outputFilter(d))
}

/**
 * This function calls the original mongodb **find().toArray()** functions and returns its result in the specified format.
 *
 * See original function:
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#find
 * @function
 * @param {object} [query={}] The cursor query object.
 * @param {object} [options] Optional settings.
 * @param {number} [options.limit=0] Sets the limit of documents returned in the query.
 * @param {(Array|object)} [options.sort] Set to sort the documents coming back from the query. Array of indexes, [['a', 1]] etc.
 * @param {object} [options.projection] The fields to return in the query. Object of fields to either include or exclude (one of, not both), {'a':1, 'b': 1} **or** {'a': 0, 'b': 0}
 * @param {object} [options.fields] **Deprecated** Use `options.projection` instead
 * @param {number} [options.skip=0] Set to skip N documents ahead in your query (useful for pagination).
 * @param {object} [options.hint] Tell the query to use specific indexes in the query. Object of indexes to use, {'_id':1}
 * @param {boolean} [options.explain=false] Explain the query instead of returning the data.
 * @param {boolean} [options.snapshot=false] DEPRECATED: Snapshot query.
 * @param {boolean} [options.timeout=false] Specify if the cursor can timeout.
 * @param {boolean} [options.tailable=false] Specify if the cursor is tailable.
 * @param {boolean} [options.awaitData=false] Specify if the cursor is a a tailable-await cursor. Requires `tailable` to be true
 * @param {number} [options.batchSize=1000] Set the batchSize for the getMoreCommand when iterating over the query results.
 * @param {boolean} [options.returnKey=false] Only return the index key.
 * @param {number} [options.maxScan] DEPRECATED: Limit the number of items to scan.
 * @param {number} [options.min] Set index bounds.
 * @param {number} [options.max] Set index bounds.
 * @param {boolean} [options.showDiskLoc=false] Show disk location of results.
 * @param {string} [options.comment] You can put a $comment field on a query to make looking in the profiler logs simpler.
 * @param {boolean} [options.raw=false] Return document results as raw BSON buffers.
 * @param {boolean} [options.promoteLongs=true] Promotes Long values to number if they fit inside the 53 bits resolution.
 * @param {boolean} [options.promoteValues=true] Promotes BSON values to native types where possible, set to false to only receive wrapper types.
 * @param {boolean} [options.promoteBuffers=false] Promotes Binary BSON values to native Node Buffers.
 * @param {(ReadPreference|string)} [options.readPreference] The preferred read preference (ReadPreference.PRIMARY, ReadPreference.PRIMARY_PREFERRED, ReadPreference.SECONDARY, ReadPreference.SECONDARY_PREFERRED, ReadPreference.NEAREST).
 * @param {boolean} [options.partial=false] Specify if the cursor should return partial results when querying against a sharded system
 * @param {number} [options.maxTimeMS] Number of milliseconds to wait before aborting the query.
 * @param {number} [options.maxAwaitTimeMS] The maximum amount of time for the server to wait on new documents to satisfy a tailable cursor query. Requires `taiable` and `awaitData` to be true
 * @param {boolean} [options.noCursorTimeout] The server normally times out idle cursors after an inactivity period (10 minutes) to prevent excess memory use. Set this option to prevent that.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {boolean} [options.allowDiskUse] Enables writing to temporary files on the server.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {string} [options.output='json'] This optional mongodet specific parameter determines the type of the data returned by this function. Valid values and data returned are:
 * - **'json'**: returns matching document(s), converted to a JSON object using the schema associated to this collection.
 * - **'db'**: returns the matching document(s), as returned by the server.
 * @throws {(MongoError|MongolError)}
 * @returns {Promise} returns a Promise. If resolved, it will send an array containing the data read from the database.
 */
Collection.prototype.findMany = function (query, options) {
    let output = 'json',
        outputFilter

    if (options && options.output) {
        output = options.output
        delete options.output
    }

    switch (output) {
        case 'json':
            outputFilter = (r) => this.dbFormatToDocument(r)
            break
        case 'db':
            outputFilter = (r) => conversion.equal(r)
            break
        default:
            throw new MongolError({
                error: `Incorrect output parameter "${output}"`
            })
    }

    outputFilter = outputFilter.bind(this)

    return this.collection
        .find(query, options)
        .toArray()
        .then((d) => outputFilter(d))
}

/**
 * Replace a document in a collection with another document
 *
 * See original function:
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#replaceOne
 * @function
 * @param {object} filter The Filter used to select the document to replace.
 * @param {object} doc The Document that replaces the matching document. This document will not be modified, but a new one (generated using the schema information) will be stored in the database taking into accounpthe document written to the data baset its data type.
 * @param {object} [options] Optional settings.
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {object} [options.hint] An optional hint for query optimization. See the {@link https://docs.mongodb.com/manual/reference/command/update/#update-command-hint|update command} reference for more information.
 * @param {boolean} [options.upsert=false] When true, creates a new document if no document matches the query.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {string} [options.output='nb'] This optional mongodet specific parameter determines the type of the data returned by this function. Valid values and data returned are:
 * - **'nb'**: the number of modified elements (0 or 1).
 * - **'raw'**: returns the whole response received from the server.
 * @returns {Promise<Collection~updateWriteOpResult>} returns Promise if no callback passed
 */
Collection.prototype.replaceOne = function (filter, doc, options) {
    let output = 'nb',
        outputFilter

    if (options && options.output) {
        output = options.output
        delete options.output
    }

    switch (output) {
        // * - **'json'**: returns the data written to the database, converted to JSON format.
        // case 'json':     outputFilter = (r) => this.dbFormatToDocument(r.ops[0]); break
        // * - **'db'**: returns the data written to the database.
        // case 'db':       outputFilter = (r) => conversion.equal(r.ops[0]); break
        case 'nb':
            outputFilter = (r) => conversion.equal(r.result.nModified)
            break
        case 'raw':
            outputFilter = conversion.equal
            break
        default:
            throw new MongolError({
                error: `Incorrect output parameter "${output}"`
            })
    }

    outputFilter = outputFilter.bind(this)

    return this.collection
        .replaceOne(filter, doc, options)
        .then((out) => outputFilter(out))
}

/**
 * Update a single document in a collection
 *
 * See original function:
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#updateOne
 * @function
 * @param {object} filter The Filter used to select the document to update
 * @param {object} update The update operations to be applied to the document
 * @param {object} [options] Optional settings.
 * @param {Array} [options.arrayFilters] optional list of array filters referenced in filtered positional operators
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {object} [options.hint] An optional hint for query optimization. See the {@link https://docs.mongodb.com/manual/reference/command/update/#update-command-hint|update command} reference for more information.
 * @param {boolean} [options.upsert=false] When true, creates a new document if no document matches the query..
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {string} [options.output='nb'] This optional mongodet specific parameter determines the type of the data returned by this function. Valid values and data returned are:
 * - **'nb'**: the number of modified elements (0 or 1).
 * - **'raw'**: returns the whole response received from the server.
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.updateOne = function (filter, update, options) {
    let output = 'nb',
        outputFilter

    if (options) {
        if (options.output) {
            output = options.output
            delete options.output
        }
    }

    switch (output) {
        case 'nb':
            outputFilter = (r) => conversion.equal(r.result.nModified)
            break
        case 'raw':
            outputFilter = conversion.equal
            break
        default:
            throw new MongolError({
                error: `Incorrect output parameter "${output}"`
            })
    }

    outputFilter = outputFilter.bind(this)

    return this.collection
        .updateOne(filter, update, options)
        .then((out) => outputFilter(out))
}

/**
 * Update multiple documents in a collection
 *
 * See original function:
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#updateMany
 * @function
 * @param {object} filter The Filter used to select the documents to update
 * @param {object} update The update operations to be applied to the documents
 * @param {object} [options] Optional settings.
 * @param {Array} [options.arrayFilters] optional list of array filters referenced in filtered positional operators
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {object} [options.hint] An optional hint for query optimization. See the {@link https://docs.mongodb.com/manual/reference/command/update/#update-command-hint|update command} reference for more information.
 * @param {boolean} [options.upsert=false] When true, creates a new document if no document matches the query..
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {string} [options.output='nb'] This optional mongodet specific parameter determines the type of the data returned by this function. Valid values and data returned are:
 * - **'nb'**: the number of modified elements.
 * - **'raw'**: returns the whole response received from the server.
 * @returns {Promise<Collection~updateWriteOpResult>} returns Promise if no callback passed
 */
Collection.prototype.updateMany = function (filter, update, options) {
    let output = 'nb',
        outputFilter

    if (options && options.output) {
        output = options.output
        delete options.output
    }

    switch (output) {
        case 'nb':
            outputFilter = (r) => conversion.equal(r.result.nModified)
            break
        case 'raw':
            outputFilter = conversion.equal
            break
        default:
            throw new MongolError({
                error: `Incorrect output parameter "${output}"`
            })
    }

    outputFilter = outputFilter.bind(this)

    return this.collection
        .updateMany(filter, update, options)
        .then((out) => outputFilter(out))
}

/**
 * Delete a document from a collection
 *
 * See original function:
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#deleteOne
 * @function
 * @param {object} filter The Filter used to select the document to remove
 * @param {object} [options] Optional settings.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {string|object} [options.hint] optional index hint for optimizing the filter query
 * @param {string} [options.output='nb'] This optional mongodet specific parameter determines the type of the data returned by this function. Valid values and data returned are:
 * - **'nb'**: the number of modified elements.
 * - **'raw'**: returns the whole response received from the server.
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.deleteOne = function (filter, options) {
    let output = 'nb',
        outputFilter

    if (options && options.output) {
        output = options.output
        delete options.output
    }

    switch (output) {
        case 'nb':
            outputFilter = (r) => conversion.equal(r.result.n)
            break
        case 'raw':
            outputFilter = conversion.equal
            break
        default:
            throw new MongolError({
                error: `Incorrect output parameter "${output}"`
            })
    }

    outputFilter = outputFilter.bind(this)

    return this.collection
        .deleteOne(filter, options)
        .then((out) => outputFilter(out))
}

/**
 * Delete multiple documents from a collection
 *
 * See original function:
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#deleteMany
 * @function
 * @param {object} filter The Filter used to select the documents to remove
 * @param {object} [options] Optional settings.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {string|object} [options.hint] optional index hint for optimizing the filter query
 * @param {string} [options.output='nb'] This optional mongodet specific parameter determines the type of the data returned by this function. Valid values and data returned are:
 * - **'nb'**: the number of modified elements.
 * - **'raw'**: returns the whole response received from the server.
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.deleteMany = function (filter, options) {
    let output = 'nb',
        outputFilter

    if (options && options.output) {
        output = options.output
        delete options.output
    }

    switch (output) {
        case 'nb':
            outputFilter = (r) => conversion.equal(r.result.n)
            break
        case 'raw':
            outputFilter = conversion.equal
            break
        default:
            throw new MongolError({
                error: `Incorrect output parameter "${output}"`
            })
    }

    outputFilter = outputFilter.bind(this)

    return this.collection
        .deleteMany(filter, options)
        .then((out) => outputFilter(out))
}

/**
 * Find a document and replace it in one atomic operation. Requires a write lock for the duration of the operation.
 *
 * See original function:
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#findOneAndReplace
 * @function
 * @param {object} filter The Filter used to select the document to replace
 * @param {object} replacement The Document that replaces the matching document
 * @param {object} [options] Optional settings.
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {string|object} [options.hint] An optional index to use for this operation
 * @param {number} [options.maxTimeMS] The maximum amount of time to allow the query to run.
 * @param {object} [options.projection] Limits the fields to return for all matching documents.
 * @param {object} [options.sort] Determines which document the operation modifies if the query selects multiple documents.
 * @param {boolean} [options.upsert=false] Upsert the document if it does not exist.
 * @param {boolean} [options.returnOriginal=true] When false, returns the updated document rather than the original. The default is true.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {string} [options.output='json'] This optional mongodet specific parameter determines the type of the data returned by this function. Valid values and data returned are:
 * - **'json'**: returns the document stored in the database before calling this function converted to JSON format.
 * - **'db'**: returns the document stored in the database before calling this function.
 * - **'nb'**: the number of modified elements (0 or 1).
 * - **'raw'**: returns the whole response received from the server.
 * @returns {Promise<Collection~findAndModifyWriteOpResultObject>} returns Promise if no callback passed
 */
Collection.prototype.findOneAndReplace = function (
    filter,
    replacement,
    options
) {
    let output = 'json',
        outputFilter

    if (options && options.output) {
        output = options.output
        delete options.output
    }

    switch (output) {
        case 'json':
            outputFilter = (r) => this.dbFormatToDocument(r.value)
            break
        case 'db':
            outputFilter = (r) => conversion.equal(r.value)
            break
        case 'nb':
            outputFilter = (r) => conversion.equal(r.lastErrorObject.n)
            break
        case 'raw':
            outputFilter = conversion.equal
            break
        default:
            throw new MongolError({
                error: `Incorrect output parameter "${output}"`
            })
    }

    outputFilter = outputFilter.bind(this)

    return this.collection
        .findOneAndReplace(filter, replacement, options)
        .then((out) => outputFilter(out))
}

/**
 * Find a document and update it in one atomic operation. Requires a write lock for the duration of the operation.
 *
 * See original function:
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#findOneAndUpdate
 * @function
 * @param {object} filter The Filter used to select the document to update
 * @param {object} update Update operations to be performed on the document
 * @param {object} [options] Optional settings.
 * @param {Array} [options.arrayFilters] optional list of array filters referenced in filtered positional operators
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {string|object} [options.hint] An optional index to use for this operation
 * @param {number} [options.maxTimeMS] The maximum amount of time to allow the query to run.
 * @param {object} [options.projection] Limits the fields to return for all matching documents.
 * @param {object} [options.sort] Determines which document the operation modifies if the query selects multiple documents.
 * @param {boolean} [options.upsert=false] Upsert the document if it does not exist.
 * @param {boolean} [options.returnOriginal=true] When false, returns the updated document rather than the original. The default is true.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] An ptional session to use for this operation
 * @param {string} [options.output='json'] This optional mongodet specific parameter determines the type of the data returned by this function. Valid values and data returned are:
 * - **'json'**: returns the document stored in the database before calling this function converted to JSON format.
 * - **'db'**: returns the document stored in the database before calling this function.
 * - **'nb'**: the number of modified elements (0 or 1).
 * - **'raw'**: returns the whole response received from the server.
 * @returns {Promise<Collection~findAndModifyWriteOpResultObject>} returns Promise if no callback passed
 */
Collection.prototype.findOneAndUpdate = function (filter, update, options) {
    let output = 'json',
        outputFilter

    if (options && options.output) {
        output = options.output
        delete options.output
    }

    switch (output) {
        case 'json':
            outputFilter = (r) => this.dbFormatToDocument(r.value)
            break
        case 'db':
            outputFilter = (r) => conversion.equal(r.value)
            break
        case 'nb':
            outputFilter = (r) => conversion.equal(r.lastErrorObject.n)
            break
        case 'raw':
            outputFilter = conversion.equal
            break
        default:
            throw new MongolError({
                error: `Incorrect output parameter "${output}"`
            })
    }

    outputFilter = outputFilter.bind(this)

    return this.collection
        .findOneAndUpdate(filter, update, options)
        .then((out) => outputFilter(out))
}

/**
 * Find a document and delete it in one atomic operation. Requires a write lock for the duration of the operation.
 *
 * See original function:
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#findOneAndDelete
 * @function
 * @param {object} filter The Filter used to select the document to remove
 * @param {object} [options] Optional settings.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {object} [options.projection] Limits the fields to return for all matching documents.
 * @param {object} [options.sort] Determines which document the operation modifies if the query selects multiple documents.
 * @param {number} [options.maxTimeMS] The maximum amount of time to allow the query to run.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {string} [options.output='json'] This optional mongodet specific parameter determines the type of the data returned by this function. Valid values and data returned are:
 * - **'json'**: returns the document stored in the database before calling this function converted to JSON format.
 * - **'db'**: returns the document stored in the database before calling this function.
 * - **'nb'**: the number of modified elements (0 or 1).
 * - **'raw'**: returns the whole response received from the server.
 * @returns {Promise<Collection~findAndModifyWriteOpResultObject>} returns Promise if no callback passed
 */
Collection.prototype.findOneAndDelete = function (filter, options) {
    let output = 'json',
        outputFilter

    if (options && options.output) {
        output = options.output
        delete options.output
    }

    switch (output) {
        case 'json':
            outputFilter = (r) => this.dbFormatToDocument(r.value)
            break
        case 'db':
            outputFilter = (r) => conversion.equal(r.value)
            break
        case 'nb':
            outputFilter = (r) => conversion.equal(r.lastErrorObject.n)
            break
        case 'raw':
            outputFilter = conversion.equal
            break
        default:
            throw new MongolError({
                error: `Incorrect output parameter "${output}"`
            })
    }

    outputFilter = outputFilter.bind(this)

    return this.collection
        .findOneAndDelete(filter, options)
        .then((out) => outputFilter(out))
}

////////////////////////////////////////////////////////////////////////////////
// Redefined mongodb methods.
////////////////////////////////////////////////////////////////////////////////

/**
 * Creates a cursor for a query that can be used to iterate over results from MongoDB
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#find
 * @function
 * @param {object} [query={}] The cursor query object.
 * @param {object} [options] Optional settings.
 * @param {number} [options.limit=0] Sets the limit of documents returned in the query.
 * @param {(Array|object)} [options.sort] Set to sort the documents coming back from the query. Array of indexes, [['a', 1]] etc.
 * @param {object} [options.projection] The fields to return in the query. Object of fields to either include or exclude (one of, not both), {'a':1, 'b': 1} **or** {'a': 0, 'b': 0}
 * @param {object} [options.fields] **Deprecated** Use `options.projection` instead
 * @param {number} [options.skip=0] Set to skip N documents ahead in your query (useful for pagination).
 * @param {object} [options.hint] Tell the query to use specific indexes in the query. Object of indexes to use, {'_id':1}
 * @param {boolean} [options.explain=false] Explain the query instead of returning the data.
 * @param {boolean} [options.snapshot=false] DEPRECATED: Snapshot query.
 * @param {boolean} [options.timeout=false] Specify if the cursor can timeout.
 * @param {boolean} [options.tailable=false] Specify if the cursor is tailable.
 * @param {boolean} [options.awaitData=false] Specify if the cursor is a a tailable-await cursor. Requires `tailable` to be true
 * @param {number} [options.batchSize=1000] Set the batchSize for the getMoreCommand when iterating over the query results.
 * @param {boolean} [options.returnKey=false] Only return the index key.
 * @param {number} [options.maxScan] DEPRECATED: Limit the number of items to scan.
 * @param {number} [options.min] Set index bounds.
 * @param {number} [options.max] Set index bounds.
 * @param {boolean} [options.showDiskLoc=false] Show disk location of results.
 * @param {string} [options.comment] You can put a $comment field on a query to make looking in the profiler logs simpler.
 * @param {boolean} [options.raw=false] Return document results as raw BSON buffers.
 * @param {boolean} [options.promoteLongs=true] Promotes Long values to number if they fit inside the 53 bits resolution.
 * @param {boolean} [options.promoteValues=true] Promotes BSON values to native types where possible, set to false to only receive wrapper types.
 * @param {boolean} [options.promoteBuffers=false] Promotes Binary BSON values to native Node Buffers.
 * @param {(ReadPreference|string)} [options.readPreference] The preferred read preference (ReadPreference.PRIMARY, ReadPreference.PRIMARY_PREFERRED, ReadPreference.SECONDARY, ReadPreference.SECONDARY_PREFERRED, ReadPreference.NEAREST).
 * @param {boolean} [options.partial=false] Specify if the cursor should return partial results when querying against a sharded system
 * @param {number} [options.maxTimeMS] Number of milliseconds to wait before aborting the query.
 * @param {number} [options.maxAwaitTimeMS] The maximum amount of time for the server to wait on new documents to satisfy a tailable cursor query. Requires `taiable` and `awaitData` to be true
 * @param {boolean} [options.noCursorTimeout] The server normally times out idle cursors after an inactivity period (10 minutes) to prevent excess memory use. Set this option to prevent that.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {boolean} [options.allowDiskUse] Enables writing to temporary files on the server.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @throws {MongoError}
 * @returns {Cursor}
 */
Collection.prototype.find = function (query, options) {
    return this.collection.find(query, options)
}

/**
 * Inserts a single document into MongoDB. If documents passed in do not contain the **_id** field,
 * one will be added to each of the documents missing it by the driver, mutating the document. This behavior
 * can be overridden by setting the **forceServerObjectId** flag.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#insertOne
 * @function
 * @param {object} doc Document to insert.
 * @param {object} [options] Optional settings.
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {boolean} [options.forceServerObjectId=false] Force server to assign _id values instead of driver.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.checkKeys=true] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~insertOneWriteOpCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.insertOneOriginal = function (doc, options, callback) {
    return this.collection.insertOne(doc, options, callback)
}

/**
 * Inserts an array of documents into MongoDB. If documents passed in do not contain the **_id** field,
 * one will be added to each of the documents missing it by the driver, mutating the document. This behavior
 * can be overridden by setting the **forceServerObjectId** flag.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#insertMany
 * @function
 * @param {object[]} docs Documents to insert.
 * @param {object} [options] Optional settings.
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {boolean} [options.ordered=true] If true, when an insert fails, don't execute the remaining writes. If false, continue with remaining inserts when one fails.
 * @param {boolean} [options.forceServerObjectId=false] Force server to assign _id values instead of driver.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.checkKeys=true] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~insertWriteOpCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.insertManyOriginal = function (docs, options, callback) {
    return this.collection.insertMany(docs, options, callback)
}

/**
 * Perform a bulkWrite operation without a fluent API
 *
 * Legal operation types are
 *
 *  { insertOne: { document: { a: 1 } } }
 *
 *  { updateOne: { filter: {a:2}, update: {$set: {a:2}}, upsert:true } }
 *
 *  { updateMany: { filter: {a:2}, update: {$set: {a:2}}, upsert:true } }
 *
 *  { updateMany: { filter: {}, update: {$set: {"a.$[i].x": 5}}, arrayFilters: [{ "i.x": 5 }]} }
 *
 *  { deleteOne: { filter: {c:1} } }
 *
 *  { deleteMany: { filter: {c:1} } }
 *
 *  { replaceOne: { filter: {c:3}, replacement: {c:4}, upsert:true}}
 *
 * If documents passed in do not contain the **_id** field,
 * one will be added to each of the documents missing it by the driver, mutating the document. This behavior
 * can be overridden by setting the **forceServerObjectId** flag.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#bulkWrite
 * @function
 * @param {object[]} operations Bulk operations to perform.
 * @param {object} [options] Optional settings.
 * @param {boolean} [options.ordered=true] Execute write operation in ordered or unordered fashion.
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {object[]} [options.arrayFilters] Determines which array elements to modify for update operation in MongoDB 3.6 or higher.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~bulkWriteOpCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.bulkWrite = function (operations, options, callback) {
    return this.collection.bulkWrite(operations, options, callback)
}

/**
 * Inserts a single document or a an array of documents into MongoDB. If documents passed in do not contain the **_id** field,
 * one will be added to each of the documents missing it by the driver, mutating the document. This behavior
 * can be overridden by setting the **forceServerObjectId** flag.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#insert
 * @function
 * @param {(object|object[])} docs Documents to insert.
 * @param {object} [options] Optional settings.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.forceServerObjectId=false] Force server to assign _id values instead of driver.
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~insertWriteOpCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 * @deprecated Use insertOne, insertMany or bulkWrite
 */
Collection.prototype.insertDeprecated = function (docs, options, callback) {
    return this.collection.insert(docs, options, callback)
}

/**
 * Update a single document in a collection
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#updateOne
 * @function
 * @param {object} filter The Filter used to select the document to update
 * @param {object} update The update operations to be applied to the document
 * @param {object} [options] Optional settings.
 * @param {Array} [options.arrayFilters] optional list of array filters referenced in filtered positional operators
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {object} [options.hint] An optional hint for query optimization. See the {@link https://docs.mongodb.com/manual/reference/command/update/#update-command-hint|update command} reference for more information.
 * @param {boolean} [options.upsert=false] When true, creates a new document if no document matches the query..
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~updateWriteOpCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.updateOneOriginal = function (
    filter,
    update,
    options,
    callback
) {
    return this.collection.updateOne(filter, update, options, callback)
}

/**
 * Replace a document in a collection with another document
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#replaceOne
 * @function
 * @param {object} filter The Filter used to select the document to replace
 * @param {object} doc The Document that replaces the matching document
 * @param {object} [options] Optional settings.
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {object} [options.hint] An optional hint for query optimization. See the {@link https://docs.mongodb.com/manual/reference/command/update/#update-command-hint|update command} reference for more information.
 * @param {boolean} [options.upsert=false] When true, creates a new document if no document matches the query.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~updateWriteOpCallback} [callback] The command result callback
 * @returns {Promise<Collection~updateWriteOpResult>} returns Promise if no callback passed
 */
Collection.prototype.replaceOneOriginal = function (
    filter,
    doc,
    options,
    callback
) {
    return this.collection.replaceOne(filter, doc, options, callback)
}

/**
 * Update multiple documents in a collection
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#updateMany
 * @function
 * @param {object} filter The Filter used to select the documents to update
 * @param {object} update The update operations to be applied to the documents
 * @param {object} [options] Optional settings.
 * @param {Array} [options.arrayFilters] optional list of array filters referenced in filtered positional operators
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {object} [options.hint] An optional hint for query optimization. See the {@link https://docs.mongodb.com/manual/reference/command/update/#update-command-hint|update command} reference for more information.
 * @param {boolean} [options.upsert=false] When true, creates a new document if no document matches the query..
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~updateWriteOpCallback} [callback] The command result callback
 * @returns {Promise<Collection~updateWriteOpResult>} returns Promise if no callback passed
 */
Collection.prototype.updateManyOriginal = function (
    filter,
    update,
    options,
    callback
) {
    return this.commection.updateMany(filter, update, options, callback)
}

/**
 * Updates documents.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#update
 * @function
 * @param {object} selector The selector for the update operation.
 * @param {object} update The update operations to be applied to the documents
 * @param {object} [options] Optional settings.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.upsert=false] Update operation is an upsert.
 * @param {boolean} [options.multi=false] Update one/all documents with operation.
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {Array} [options.arrayFilters] optional list of array filters referenced in filtered positional operators
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {object} [options.hint] An optional hint for query optimization. See the {@link https://docs.mongodb.com/manual/reference/command/update/#update-command-hint|update command} reference for more information.
 * @param {Collection~writeOpCallback} [callback] The command result callback
 * @throws {MongoError}
 * @returns {Promise} returns Promise if no callback passed
 * @deprecated use updateOne, updateMany or bulkWrite
 */
Collection.prototype.updateDeprecated = function (
    selector,
    update,
    options,
    callback
) {
    return this.collection.update(selector, update, options, callback)
}

/**
 * Delete a document from a collection
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#deleteOne
 * @function
 * @param {object} filter The Filter used to select the document to remove
 * @param {object} [options] Optional settings.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {string|object} [options.hint] optional index hint for optimizing the filter query
 * @param {Collection~deleteWriteOpCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.deleteOneOriginal = function (filter, options, callback) {
    return this.collection.deleteOne(filter, options, callback)
}

/**
 * Delete multiple documents from a collection
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#deleteMany
 * @function
 * @param {object} filter The Filter used to select the documents to remove
 * @param {object} [options] Optional settings.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {string|object} [options.hint] optional index hint for optimizing the filter query
 * @param {Collection~deleteWriteOpCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.deleteManyOriginal = function (filter, options, callback) {
    return this.collection.deleteMany(filter, options, callback)
}

/**
 * Remove documents.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#remove
 * @function
 * @param {object} selector The selector for the update operation.
 * @param {object} [options] Optional settings.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.single=false] Removes the first document found.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~writeOpCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 * @deprecated use deleteOne, deleteMany or bulkWrite
 */
Collection.prototype.removeDeprecated = function (selector, options, callback) {
    return this.collection.remove(selector, options, callback)
}

/**
 * Save a document. Simple full document replacement function. Not recommended for efficiency, use atomic
 * operators and update instead for more efficient operations.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#save
 * @function
 * @param {object} doc Document to save
 * @param {object} [options] Optional settings.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~writeOpCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 * @deprecated use insertOne, insertMany, updateOne or updateMany
 */
Collection.prototype.saveDeprecated = function (doc, options, callback) {
    return this.collection.save(doc, options, callback)
}

/**
 * Fetches the first document that matches the query
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#findOne
 * @function
 * @param {object} query Query for find Operation
 * @param {object} [options] Optional settings.
 * @param {number} [options.limit=0] Sets the limit of documents returned in the query.
 * @param {(Array|object)} [options.sort] Set to sort the documents coming back from the query. Array of indexes, [['a', 1]] etc.
 * @param {object} [options.projection] The fields to return in the query. Object of fields to include or exclude (not both), {'a':1}
 * @param {object} [options.fields] **Deprecated** Use `options.projection` instead
 * @param {number} [options.skip=0] Set to skip N documents ahead in your query (useful for pagination).
 * @param {object} [options.hint] Tell the query to use specific indexes in the query. Object of indexes to use, {'_id':1}
 * @param {boolean} [options.explain=false] Explain the query instead of returning the data.
 * @param {boolean} [options.snapshot=false] DEPRECATED: Snapshot query.
 * @param {boolean} [options.timeout=false] Specify if the cursor can timeout.
 * @param {boolean} [options.tailable=false] Specify if the cursor is tailable.
 * @param {number} [options.batchSize=1] Set the batchSize for the getMoreCommand when iterating over the query results.
 * @param {boolean} [options.returnKey=false] Only return the index key.
 * @param {number} [options.maxScan] DEPRECATED: Limit the number of items to scan.
 * @param {number} [options.min] Set index bounds.
 * @param {number} [options.max] Set index bounds.
 * @param {boolean} [options.showDiskLoc=false] Show disk location of results.
 * @param {string} [options.comment] You can put a $comment field on a query to make looking in the profiler logs simpler.
 * @param {boolean} [options.raw=false] Return document results as raw BSON buffers.
 * @param {boolean} [options.promoteLongs=true] Promotes Long values to number if they fit inside the 53 bits resolution.
 * @param {boolean} [options.promoteValues=true] Promotes BSON values to native types where possible, set to false to only receive wrapper types.
 * @param {boolean} [options.promoteBuffers=false] Promotes Binary BSON values to native Node Buffers.
 * @param {(ReadPreference|string)} [options.readPreference] The preferred read preference (ReadPreference.PRIMARY, ReadPreference.PRIMARY_PREFERRED, ReadPreference.SECONDARY, ReadPreference.SECONDARY_PREFERRED, ReadPreference.NEAREST).
 * @param {boolean} [options.partial=false] Specify if the cursor should return partial results when querying against a sharded system
 * @param {number} [options.maxTimeMS] Number of milliseconds to wait before aborting the query.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.findOneOriginal = function (query, options, callback) {
    return this.collection.findOne(query, options, callback)
}

/**
 * Rename the collection.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#rename
 * @function
 * @param {string} newName New name of of the collection.
 * @param {object} [options] Optional settings.
 * @param {boolean} [options.dropTarget=false] Drop the target name collection if it previously exists.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~collectionResultCallback} [callback] The results callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.rename = function (newName, options, callback) {
    return this.collection.rename(newName, options, callback)
}

/**
 * Drop the collection from the database, removing it permanently. New accesses will create a new collection.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#drop
 * @function
 * @param {object} [options] Optional settings.
 * @param {WriteConcern} [options.writeConcern] A full WriteConcern object
 * @param {(number|string)} [options.w] The write concern
 * @param {number} [options.wtimeout] The write concern timeout
 * @param {boolean} [options.j] The journal write concern
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The results callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.drop = function (options, callback) {
    return this.collection.drop(options, callback)
}

/**
 * Returns the options of the collection.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#options
 * @function
 * @param {object} [options] Optional settings
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The results callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.options = function (options, callback) {
    return this.collection.options(options, callback)
}

/**
 * Returns if the collection is a capped collection
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#isCapped
 * @function
 * @param {object} [options] Optional settings
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The results callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.isCapped = function (options, callback) {
    return this.collection.isCapped(options, callback)
}

/**
 * Creates an index on the db and collection collection.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#createIndex
 * @function
 * @param {(string|Array|object)} fieldOrSpec Defines the index.
 * @param {object} [options] Optional settings.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.unique=false] Creates an unique index.
 * @param {boolean} [options.sparse=false] Creates a sparse index.
 * @param {boolean} [options.background=false] Creates the index in the background, yielding whenever possible.
 * @param {boolean} [options.dropDups=false] A unique index cannot be created on a key that has pre-existing duplicate values. If you would like to create the index anyway, keeping the first document the database indexes and deleting all subsequent documents that have duplicate value
 * @param {number} [options.min] For geospatial indexes set the lower bound for the co-ordinates.
 * @param {number} [options.max] For geospatial indexes set the high bound for the co-ordinates.
 * @param {number} [options.v] Specify the format version of the indexes.
 * @param {number} [options.expireAfterSeconds] Allows you to expire data on indexes applied to a data (MongoDB 2.2 or higher)
 * @param {string} [options.name] Override the autogenerated index name (useful if the resulting name is larger than 128 bytes)
 * @param {object} [options.partialFilterExpression] Creates a partial index based on the given filter object (MongoDB 3.2 or higher)
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 * @example
 * const collection = client.db('foo').collection('bar');
 *
 * await collection.createIndex({ a: 1, b: -1 });
 *
 * // Alternate syntax for { c: 1, d: -1 } that ensures order of indexes
 * await collection.createIndex([ [c, 1], [d, -1] ]);
 *
 * // Equivalent to { e: 1 }
 * await collection.createIndex('e');
 *
 * // Equivalent to { f: 1, g: 1 }
 * await collection.createIndex(['f', 'g'])
 *
 * // Equivalent to { h: 1, i: -1 }
 * await collection.createIndex([ { h: 1 }, { i: -1 } ]);
 *
 * // Equivalent to { j: 1, k: -1, l: 2d }
 * await collection.createIndex(['j', ['k', -1], { l: '2d' }])
 */
Collection.prototype.createIndex = function (fieldOrSpec, options, callback) {
    return this.collection.createIndex(fieldOrSpec, options, callback)
}

/**
 * Creates multiple indexes in the collection, this method is only supported for
 * MongoDB 2.6 or higher. Earlier version of MongoDB will throw a command not supported
 * error.
 *
 * **Note**: Unlike {@link Collection#createIndex createIndex}, this function takes in raw index specifications.
 * Index specifications are defined {@link http://docs.mongodb.org/manual/reference/command/createIndexes/ here}.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#createIndexes
 * @function
 * @param {Collection~IndexDefinition[]} indexSpecs An array of index specifications to be created
 * @param {object} [options] Optional settings
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 * @example
 * const collection = client.db('foo').collection('bar');
 * await collection.createIndexes([
 *   // Simple index on field fizz
 *   {
 *     key: { fizz: 1 },
 *   }
 *   // wildcard index
 *   {
 *     key: { '$**': 1 }
 *   },
 *   // named index on darmok and jalad
 *   {
 *     key: { darmok: 1, jalad: -1 }
 *     name: 'tanagra'
 *   }
 * ]);
 */
Collection.prototype.createIndexesOriginal = function (
    indexSpecs,
    options,
    callback
) {
    return this.collection.createIndexes(indexSpecs, options, callback)
}

/**
 * Drops an index from this collection.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#dropIndex
 * @function
 * @param {string} indexName Name of the index to drop.
 * @param {object} [options] Optional settings.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {number} [options.maxTimeMS] Number of milliseconds to wait before aborting the query.
 * @param {Collection~resultCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.dropIndex = function (indexName, options, callback) {
    return this.collection.dropIndex(indexName, options, callback)
}

/**
 * Drops all indexes from this collection.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#dropIndexes
 * @function
 * @param {object} [options] Optional settings
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {number} [options.maxTimeMS] Number of milliseconds to wait before aborting the query.
 * @param {Collection~resultCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.dropIndexes = function (options, callback) {
    return this.collection.dropIndexes(options, callback)
}

/**
 * Drops all indexes from this collection.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#dropAllIndexes
 * @function
 * @deprecated use dropIndexes
 * @param {Collection~resultCallback} callback The command result callback
 * @returns {Promise} returns Promise if no [callback] passed
 */
Collection.prototype.dropAllIndexesDeprecated = function (callback) {
    return this.collection.dropAllIndexes(callback)
}

/**
 * Reindex all indexes on the collection
 * Warning: reIndex is a blocking operation (indexes are rebuilt in the foreground) and will be slow for large collections.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#reIndex
 * @function
 * @param {object} [options] Optional settings
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.reIndex = function (options, callback) {
    return this.collection.reIndex(options, callback)
}

/**
 * Get the list of all indexes information for the collection.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#listIndexes
 * @function
 * @param {object} [options] Optional settings.
 * @param {number} [options.batchSize=1000] The batchSize for the returned command cursor or if pre 2.8 the systems batch collection
 * @param {(ReadPreference|string)} [options.readPreference] The preferred read preference (ReadPreference.PRIMARY, ReadPreference.PRIMARY_PREFERRED, ReadPreference.SECONDARY, ReadPreference.SECONDARY_PREFERRED, ReadPreference.NEAREST).
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @returns {CommandCursor}
 */
Collection.prototype.listIndexes = function (options) {
    return this.collection.listIndexes(options)
}

/**
 * Ensures that an index exists, if it does not it creates it
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#ensureIndex
 * @function
 * @deprecated use createIndexes instead
 * @param {(string|object)} fieldOrSpec Defines the index.
 * @param {object} [options] Optional settings.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.unique=false] Creates an unique index.
 * @param {boolean} [options.sparse=false] Creates a sparse index.
 * @param {boolean} [options.background=false] Creates the index in the background, yielding whenever possible.
 * @param {boolean} [options.dropDups=false] A unique index cannot be created on a key that has pre-existing duplicate values. If you would like to create the index anyway, keeping the first document the database indexes and deleting all subsequent documents that have duplicate value
 * @param {number} [options.min] For geospatial indexes set the lower bound for the co-ordinates.
 * @param {number} [options.max] For geospatial indexes set the high bound for the co-ordinates.
 * @param {number} [options.v] Specify the format version of the indexes.
 * @param {number} [options.expireAfterSeconds] Allows you to expire data on indexes applied to a data (MongoDB 2.2 or higher)
 * @param {number} [options.name] Override the autogenerated index name (useful if the resulting name is larger than 128 bytes)
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.ensureIndexDeprecated = function (
    fieldOrSpec,
    options,
    callback
) {
    return this.collection.ensureIndex(fieldOrSpec, options, callback)
}

/**
 * Checks if one or more indexes exist on the collection, fails on first non-existing index
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#indexExists
 * @function
 * @param {(string|Array)} indexes One or more index names to check.
 * @param {object} [options] Optional settings
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.indexExists = function (indexes, options, callback) {
    return this.collection.indexExists(indexes, options, callback)
}

/**
 * Retrieves this collections index info.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#indexInformation
 * @function
 * @param {object} [options] Optional settings.
 * @param {boolean} [options.full=false] Returns the full raw index information.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.indexInformation = function (options, callback) {
    return this.collection.indexInformation(options, callback)
}

/**
 * An estimated count of matching documents in the db to a query.
 *
 * **NOTE:** This method has been deprecated, since it does not provide an accurate count of the documents
 * in a collection. To obtain an accurate count of documents in the collection, use {@link Collection#countDocuments countDocuments}.
 * To obtain an estimated count of all documents in the collection, use {@link Collection#estimatedDocumentCount estimatedDocumentCount}.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#count
 * @function
 * @param {object} [query={}] The query for the count.
 * @param {object} [options] Optional settings.
 * @param {object} [options.collation] Specify collation settings for operation. See {@link https://docs.mongodb.com/manual/reference/command/aggregate|aggregation documentation}.
 * @param {boolean} [options.limit] The limit of documents to count.
 * @param {boolean} [options.skip] The number of documents to skip for the count.
 * @param {string} [options.hint] An index name hint for the query.
 * @param {(ReadPreference|string)} [options.readPreference] The preferred read preference (ReadPreference.PRIMARY, ReadPreference.PRIMARY_PREFERRED, ReadPreference.SECONDARY, ReadPreference.SECONDARY_PREFERRED, ReadPreference.NEAREST).
 * @param {number} [options.maxTimeMS] Number of milliseconds to wait before aborting the query.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~countCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 * @deprecated use {@link Collection#countDocuments countDocuments} or {@link Collection#estimatedDocumentCount estimatedDocumentCount} instead
 */
Collection.prototype.countDeprecated = function (query, options, callback) {
    return this.collection.count(query, options, callback)
}

/**
 * Gets an estimate of the count of documents in a collection using collection metadata.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#estimatedDocumentCount
 * @function
 * @param {object} [options] Optional settings.
 * @param {number} [options.maxTimeMS] The maximum amount of time to allow the operation to run.
 * @param {Collection~countCallback} [callback] The command result callback.
 * @returns {Promise} returns Promise if no callback passed.
 */
Collection.prototype.estimatedDocumentCount = function (options, callback) {
    return this.collection.estimatedDocumentCount(options, callback)
}

/**
 * Gets the number of documents matching the filter.
 * For a fast count of the total documents in a collection see {@link Collection#estimatedDocumentCount estimatedDocumentCount}.
 * **Note**: When migrating from {@link Collection#count count} to {@link Collection#countDocuments countDocuments}
 * the following query operators must be replaced:
 *
 * | Operator | Replacement |
 * | -------- | ----------- |
 * | `$where`   | [`$expr`][1] |
 * | `$near`    | [`$geoWithin`][2] with [`$center`][3] |
 * | `$nearSphere` | [`$geoWithin`][2] with [`$centerSphere`][4] |
 *
 * [1]: https://docs.mongodb.com/manual/reference/operator/query/expr/
 * [2]: https://docs.mongodb.com/manual/reference/operator/query/geoWithin/
 * [3]: https://docs.mongodb.com/manual/reference/operator/query/center/#op._S_center
 * [4]: https://docs.mongodb.com/manual/reference/operator/query/centerSphere/#op._S_centerSphere
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#countDocuments
 * @param {object} [query] the query for the count
 * @param {object} [options] Optional settings.
 * @param {object} [options.collation] Specifies a collation.
 * @param {string|object} [options.hint] The index to use.
 * @param {number} [options.limit] The maximum number of document to count.
 * @param {number} [options.maxTimeMS] The maximum amount of time to allow the operation to run.
 * @param {number} [options.skip] The number of documents to skip before counting.
 * @param {Collection~countCallback} [callback] The command result callback.
 * @returns {Promise} returns Promise if no callback passed.
 * @see https://docs.mongodb.com/manual/reference/operator/query/expr/
 * @see https://docs.mongodb.com/manual/reference/operator/query/geoWithin/
 * @see https://docs.mongodb.com/manual/reference/operator/query/center/#op._S_center
 * @see https://docs.mongodb.com/manual/reference/operator/query/centerSphere/#op._S_centerSphere
 */
Collection.prototype.countDocuments = function (query, options, callback) {
    return this.collection.countDocuments(query, options, callback)
}

/**
 * The distinct command returns a list of distinct values for the given key across a collection.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#distinct
 * @function
 * @param {string} key Field of the document to find distinct values for.
 * @param {object} [query] The query for filtering the set of documents to which we apply the distinct filter.
 * @param {object} [options] Optional settings.
 * @param {(ReadPreference|string)} [options.readPreference] The preferred read preference (ReadPreference.PRIMARY, ReadPreference.PRIMARY_PREFERRED, ReadPreference.SECONDARY, ReadPreference.SECONDARY_PREFERRED, ReadPreference.NEAREST).
 * @param {number} [options.maxTimeMS] Number of milliseconds to wait before aborting the query.
 * @param {object} [options.collation] Specify collation settings for operation. See {@link https://docs.mongodb.com/manual/reference/command/aggregate|aggregation documentation}.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.distinct = function (key, query, options, callback) {
    return this.collection.distinct(key, query, options, callback)
}

/**
 * Retrieve all the indexes on the collection.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#indexes
 * @function
 * @param {object} [options] Optional settings
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.indexes = function (options, callback) {
    return this.collection.indexes(options, callback)
}

/**
 * Get all the collection statistics.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#stats
 * @function
 * @param {object} [options] Optional settings.
 * @param {number} [options.scale] Divide the returned sizes by scale value.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The collection result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.stats = function (options, callback) {
    return this.collection.stats(options, callback)
}

/**
 * Find a document and delete it in one atomic operation. Requires a write lock for the duration of the operation.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#findOneAndDelete
 * @function
 * @param {object} filter The Filter used to select the document to remove
 * @param {object} [options] Optional settings.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {object} [options.projection] Limits the fields to return for all matching documents.
 * @param {object} [options.sort] Determines which document the operation modifies if the query selects multiple documents.
 * @param {number} [options.maxTimeMS] The maximum amount of time to allow the query to run.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~findAndModifyCallback} [callback] The collection result callback
 * @returns {Promise<Collection~findAndModifyWriteOpResultObject>} returns Promise if no callback passed
 */
Collection.prototype.findOneAndDeleteOriginal = function (
    filter,
    options,
    callback
) {
    return this.collection.findOneAndDelete(filter, options, callback)
}

/**
 * Find a document and replace it in one atomic operation. Requires a write lock for the duration of the operation.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#findOneAndReplace
 * @function
 * @param {object} filter The Filter used to select the document to replace
 * @param {object} replacement The Document that replaces the matching document
 * @param {object} [options] Optional settings.
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {string|object} [options.hint] An optional index to use for this operation
 * @param {number} [options.maxTimeMS] The maximum amount of time to allow the query to run.
 * @param {object} [options.projection] Limits the fields to return for all matching documents.
 * @param {object} [options.sort] Determines which document the operation modifies if the query selects multiple documents.
 * @param {boolean} [options.upsert=false] Upsert the document if it does not exist.
 * @param {boolean} [options.returnOriginal=true] When false, returns the updated document rather than the original. The default is true.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~findAndModifyCallback} [callback] The collection result callback
 * @returns {Promise<Collection~findAndModifyWriteOpResultObject>} returns Promise if no callback passed
 */
Collection.prototype.findOneAndReplaceOriginal = function (
    filter,
    replacement,
    options,
    callback
) {
    return this.collection.findOneAndReplace(
        filter,
        replacement,
        options,
        callback
    )
}

/**
 * Find a document and update it in one atomic operation. Requires a write lock for the duration of the operation.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#findOneAndUpdate
 * @function
 * @param {object} filter The Filter used to select the document to update
 * @param {object} update Update operations to be performed on the document
 * @param {object} [options] Optional settings.
 * @param {Array} [options.arrayFilters] optional list of array filters referenced in filtered positional operators
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {string|object} [options.hint] An optional index to use for this operation
 * @param {number} [options.maxTimeMS] The maximum amount of time to allow the query to run.
 * @param {object} [options.projection] Limits the fields to return for all matching documents.
 * @param {object} [options.sort] Determines which document the operation modifies if the query selects multiple documents.
 * @param {boolean} [options.upsert=false] Upsert the document if it does not exist.
 * @param {boolean} [options.returnOriginal=true] When false, returns the updated document rather than the original. The default is true.
 * @param {boolean} [options.checkKeys=false] If true, will throw if bson documents start with `$` or include a `.` in any key value
 * @param {boolean} [options.serializeFunctions=false] Serialize functions on any object.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] An ptional session to use for this operation
 * @param {Collection~findAndModifyCallback} [callback] The collection result callback
 * @returns {Promise<Collection~findAndModifyWriteOpResultObject>} returns Promise if no callback passed
 */
Collection.prototype.findOneAndUpdateOriginal = function (
    filter,
    update,
    options,
    callback
) {
    return this.collection.findOneAndUpdate(filter, update, options, callback)
}

/**
 * Find and update a document.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#findAndModify
 * @function
 * @param {object} query Query object to locate the object to modify.
 * @param {Array} sort If multiple docs match, choose the first one in the specified sort order as the object to manipulate.
 * @param {object} doc The fields/vals to be updated.
 * @param {object} [options] Optional settings.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.remove=false] Set to true to remove the object before returning.
 * @param {boolean} [options.upsert=false] Perform an upsert operation.
 * @param {boolean} [options.new=false] Set to true if you want to return the modified object rather than the original. Ignored for remove.
 * @param {object} [options.projection] Object containing the field projection for the result returned from the operation.
 * @param {object} [options.fields] **Deprecated** Use `options.projection` instead
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Array} [options.arrayFilters] optional list of array filters referenced in filtered positional operators
 * @param {Collection~findAndModifyCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 * @deprecated use findOneAndUpdate, findOneAndReplace or findOneAndDelete instead
 */
Collection.prototype.findAndModifyDeprecated = function (
    query,
    sort,
    doc,
    options,
    callback
) {
    return this.collection.findAndModify(query, sort, doc, options, callback)
}

/**
 * Find and remove a document.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#findAndRemove
 * @function
 * @param {object} query Query object to locate the object to modify.
 * @param {Array} sort If multiple docs match, choose the first one in the specified sort order as the object to manipulate.
 * @param {object} [options] Optional settings.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 * @deprecated use findOneAndDelete instead
 */
Collection.prototype.findAndRemoveDeprecated = function (
    query,
    sort,
    options,
    callback
) {
    return this.collection.findAndRemove(query, sort, options, callback)
}

/**
 * Execute an aggregation framework pipeline against the collection, needs MongoDB >= 2.2
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#aggregate
 * @function
 * @param {object} [pipeline=[]] Array containing all the aggregation framework commands for the execution.
 * @param {object} [options] Optional settings.
 * @param {(ReadPreference|string)} [options.readPreference] The preferred read preference (ReadPreference.PRIMARY, ReadPreference.PRIMARY_PREFERRED, ReadPreference.SECONDARY, ReadPreference.SECONDARY_PREFERRED, ReadPreference.NEAREST).
 * @param {number} [options.batchSize=1000] The number of documents to return per batch. See {@link https://docs.mongodb.com/manual/reference/command/aggregate|aggregation documentation}.
 * @param {object} [options.cursor] Return the query as cursor, on 2.6 > it returns as a real cursor on pre 2.6 it returns as an emulated cursor.
 * @param {number} [options.cursor.batchSize=1000] Deprecated. Use `options.batchSize`
 * @param {boolean} [options.explain=false] Explain returns the aggregation execution plan (requires mongodb 2.6 >).
 * @param {boolean} [options.allowDiskUse=false] allowDiskUse lets the server know if it can use disk to store temporary results for the aggregation (requires mongodb 2.6 >).
 * @param {number} [options.maxTimeMS] maxTimeMS specifies a cumulative time limit in milliseconds for processing operations on the cursor. MongoDB interrupts the operation at the earliest following interrupt point.
 * @param {number} [options.maxAwaitTimeMS] The maximum amount of time for the server to wait on new documents to satisfy a tailable cursor query.
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {boolean} [options.raw=false] Return document results as raw BSON buffers.
 * @param {boolean} [options.promoteLongs=true] Promotes Long values to number if they fit inside the 53 bits resolution.
 * @param {boolean} [options.promoteValues=true] Promotes BSON values to native types where possible, set to false to only receive wrapper types.
 * @param {boolean} [options.promoteBuffers=false] Promotes Binary BSON values to native Node Buffers.
 * @param {object} [options.collation] Specify collation (MongoDB 3.4 or higher) settings for update operation (see 3.4 documentation for available fields).
 * @param {string} [options.comment] Add a comment to an aggregation command
 * @param {string|object} [options.hint] Add an index selection hint to an aggregation command
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @returns {AggregationCursor}
 */
Collection.prototype.aggregate = function (pipeline, options) {
    return this.collection.aggregate(pipeline, options)
}

/**
 * Create a new Change Stream, watching for new changes (insertions, updates, replacements, deletions, and invalidations) in this collection.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#watch
 * @function
 * @since 3.0.0
 * @param {Array} [pipeline] An array of {@link https://docs.mongodb.com/manual/reference/operator/aggregation-pipeline/|aggregation pipeline stages} through which to pass change stream documents. This allows for filtering (using $match) and manipulating the change stream documents.
 * @param {object} [options] Optional settings
 * @param {string} [options.fullDocument='default'] Allowed values: ‘default’, ‘updateLookup’. When set to ‘updateLookup’, the change stream will include both a delta describing the changes to the document, as well as a copy of the entire document that was changed from some time after the change occurred.
 * @param {object} [options.resumeAfter] Specifies the logical starting point for the new change stream. This should be the _id field from a previously returned change stream document.
 * @param {number} [options.maxAwaitTimeMS] The maximum amount of time for the server to wait on new documents to satisfy a change stream query
 * @param {number} [options.batchSize=1000] The number of documents to return per batch. See {@link https://docs.mongodb.com/manual/reference/command/aggregate|aggregation documentation}.
 * @param {object} [options.collation] Specify collation settings for operation. See {@link https://docs.mongodb.com/manual/reference/command/aggregate|aggregation documentation}.
 * @param {ReadPreference} [options.readPreference] The read preference. Defaults to the read preference of the database or collection. See {@link https://docs.mongodb.com/manual/reference/read-preference|read preference documentation}.
 * @param {Timestamp} [options.startAtOperationTime] receive change events that occur after the specified timestamp
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @returns {ChangeStream} a ChangeStream instance.
 */
Collection.prototype.watch = function (pipeline, options) {
    return this.collection.watch(pipeline, options)
}

/**
 * Return N number of parallel cursors for a collection allowing parallel reading of entire collection. There are
 * no ordering guarantees for returned results.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#parallelCollectionScan
 * @function
 * @param {object} [options] Optional settings.
 * @param {(ReadPreference|string)} [options.readPreference] The preferred read preference (ReadPreference.PRIMARY, ReadPreference.PRIMARY_PREFERRED, ReadPreference.SECONDARY, ReadPreference.SECONDARY_PREFERRED, ReadPreference.NEAREST).
 * @param {number} [options.batchSize=1000] Set the batchSize for the getMoreCommand when iterating over the query results.
 * @param {number} [options.numCursors=1] The maximum number of parallel command cursors to return (the number of returned cursors will be in the range 1:numCursors)
 * @param {boolean} [options.raw=false] Return all BSON documents as Raw Buffer documents.
 * @param {Collection~parallelCollectionScanCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.parallelCollectionScanDeprecated = function (
    options,
    callback
) {
    return this.collection.parallelCollectionScan(options, callback)
}

/**
 * Execute a geo search using a geo haystack index on a collection.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#geoHaystackSearch
 * @function
 * @param {number} x Point to search on the x axis, ensure the indexes are ordered in the same order.
 * @param {number} y Point to search on the y axis, ensure the indexes are ordered in the same order.
 * @param {object} [options] Optional settings.
 * @param {(ReadPreference|string)} [options.readPreference] The preferred read preference (ReadPreference.PRIMARY, ReadPreference.PRIMARY_PREFERRED, ReadPreference.SECONDARY, ReadPreference.SECONDARY_PREFERRED, ReadPreference.NEAREST).
 * @param {number} [options.maxDistance] Include results up to maxDistance from the point.
 * @param {object} [options.search] Filter the results by a query.
 * @param {number} [options.limit=false] Max number of results to return.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.geoHaystackSearch = function (x, y, options, callback) {
    return this.collection.geoHaystackSearch(x, y, options, callback)
}

/**
 * Run a group command across a collection
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#group
 * @function
 * @param {(object|Array|Function|code)} keys An object, array or function expressing the keys to group by.
 * @param {object} condition An optional condition that must be true for a row to be considered.
 * @param {object} initial Initial value of the aggregation counter object.
 * @param {(Function|Code)} reduce The reduce function aggregates (reduces) the objects iterated
 * @param {(Function|Code)} finalize An optional function to be run on each item in the result set just before the item is returned.
 * @param {boolean} command Specify if you wish to run using the internal group command or using eval, default is true.
 * @param {object} [options] Optional settings.
 * @param {(ReadPreference|string)} [options.readPreference] The preferred read preference (ReadPreference.PRIMARY, ReadPreference.PRIMARY_PREFERRED, ReadPreference.SECONDARY, ReadPreference.SECONDARY_PREFERRED, ReadPreference.NEAREST).
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The command result callback
 * @returns {Promise} returns Promise if no callback passed
 * @deprecated MongoDB 3.6 or higher no longer supports the group command. We recommend rewriting using the aggregation framework.
 */
Collection.prototype.groupDeprecated = function (
    keys,
    condition,
    initial,
    reduce,
    finalize,
    command,
    options,
    callback
) {
    return this.collection.group(
        keys,
        condition,
        initial,
        reduce,
        finalize,
        command,
        options,
        callback
    )
}

/**
 * Run Map Reduce across a collection. Be aware that the inline option for out will return an array of results not a collection.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#mapReduce
 * @function
 * @param {(Function|string)} map The mapping function.
 * @param {(Function|string)} reduce The reduce function.
 * @param {object} [options] Optional settings.
 * @param {(ReadPreference|string)} [options.readPreference] The preferred read preference (ReadPreference.PRIMARY, ReadPreference.PRIMARY_PREFERRED, ReadPreference.SECONDARY, ReadPreference.SECONDARY_PREFERRED, ReadPreference.NEAREST).
 * @param {object} [options.out] Sets the output target for the map reduce job. *{inline:1} | {replace:'collectionName'} | {merge:'collectionName'} | {reduce:'collectionName'}*
 * @param {object} [options.query] Query filter object.
 * @param {object} [options.sort] Sorts the input objects using this key. Useful for optimization, like sorting by the emit key for fewer reduces.
 * @param {number} [options.limit] Number of objects to return from collection.
 * @param {boolean} [options.keeptemp=false] Keep temporary data.
 * @param {(Function|string)} [options.finalize] Finalize function.
 * @param {object} [options.scope] Can pass in variables that can be access from map/reduce/finalize.
 * @param {boolean} [options.jsMode=false] It is possible to make the execution stay in JS. Provided in MongoDB > 2.0.X.
 * @param {boolean} [options.verbose=false] Provide statistics on job execution time.
 * @param {boolean} [options.bypassDocumentValidation=false] Allow driver to bypass schema validation in MongoDB 3.2 or higher.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {Collection~resultCallback} [callback] The command result callback
 * @throws {MongoError}
 * @returns {Promise} returns Promise if no callback passed
 */
Collection.prototype.mapReduce = function (map, reduce, options, callback) {
    return this.collection.mapReduce(map, reduce, options, callback)
}

/**
 * Initiate an Out of order batch write operation. All operations will be buffered into insert/update/remove commands executed out of order.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#initializeUnorderedBulkOp
 * @function
 * @param {object} [options] Optional settings.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @returns {UnorderedBulkOperation}
 */
Collection.prototype.initializeUnorderedBulkOp = function (options) {
    return this.collection.initializeUnorderedBulkOp(options)
}

/**
 * Initiate an In order bulk write operation. Operations will be serially executed in the order they are added, creating a new operation for each switch in types.
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#initializeOrderedBulkOp
 * @function
 * @param {object} [options] Optional settings.
 * @param {(number|string)} [options.w] The write concern.
 * @param {number} [options.wtimeout] The write concern timeout.
 * @param {boolean} [options.j=false] Specify a journal write concern.
 * @param {ClientSession} [options.session] optional session to use for this operation
 * @param {boolean} [options.ignoreUndefined=false] Specify if the BSON serializer should ignore undefined fields.
 * @returns {OrderedBulkOperation}
 */
Collection.prototype.initializeOrderedBulkOp = function (options) {
    return this.collection.initializeOrderedBulkOp(options)
}

/**
 * Return the db logger
 * https://mongodb.github.io/node-mongodb-native/3.5/api/Collection.html#getLogger
 * @function
 * @returns {Logger} return the db logger
 */
Collection.prototype.getLogger = function () {
    return this.collection.getLogger()
}
