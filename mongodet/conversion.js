'use strict'

const { valueToDbFormat, dbFormatToValue } = require('./types')

function convertDocument(data, schema, convertValue) {
    function convertElement(schema, data) {
        if (schema.$ref) {
            // '#/definitions/address'
            let refSchema = originalSchema
            schema.$ref
                .replace('#/', '')
                .split('/')
                .map((p) => {
                    if (refSchema) refSchema = refSchema[p]
                })
            schema = refSchema
        }

        if (data.constructor.name === 'Object') {
            let ret = {}
            for (let v in data) {
                if (Object.prototype.hasOwnProperty.call(data, v)) {
                    let encoding, mongoType, schemaV

                    switch (data[v].constructor.name) {
                        case 'Object':
                        case 'Array':
                            schemaV =
                                schema &&
                                schema.properties &&
                                schema.properties[v]
                                    ? schema.properties[v]
                                    : null
                            ret[v] = convertElement(schemaV, data[v])
                            break

                        default:
                            encoding =
                                schema &&
                                schema.properties &&
                                schema.properties[v]
                                    ? schema.properties[v].encoding
                                    : ''
                            mongoType =
                                schema &&
                                schema.properties &&
                                schema.properties[v]
                                    ? schema.properties[v].mongoType
                                    : ''
                            ret[v] = convertValue(data[v], mongoType, encoding)
                            break
                    }
                }
            }
            return ret
        }

        if (data.constructor.name === 'Array') {
            let ret = []
            for (let i = 0; i < data.length; i++) {
                let schemaI
                if (schema && schema.items) {
                    if (schema.items.constructor.name === 'Object') {
                        schemaI = schema.items
                    } else if (schema.items.constructor.name === 'Array') {
                        if (i < schema.items.length) schemaI = schema.items[i]
                        else schemaI = schema.additionalItems
                    }
                }

                let encoding, mongoType

                switch (data[i].constructor.name) {
                    case 'Object':
                    case 'Array':
                        ret[i] = convertElement(schemaI, data[i])
                        break

                    default:
                        encoding = schemaI ? schemaI.encoding : ''
                        mongoType = schemaI ? schemaI.mongoType : ''
                        ret[i] = convertValue(data[i], mongoType, encoding)
                        break
                }
            }
            return ret
        }

        throw new Error(
            'This function manages directly only objects and arrays'
        )
    } // function convertElement (schema,data)

    if (!schema) return data

    if (!data)
        // The database may return nothing. In this case, this function must not parse the null result.
        return data

    const originalSchema = schema

    if (data.constructor.name === 'Array') {
        let ret = []
        for (let i = 0; i < data.length; i++)
            ret.push(convertElement(schema, data[i]))
        return ret
    } else {
        return convertElement(schema, data)
    }
}

/**
 * This function converts a json object into an equivalent containing the mongodb format.
 * @function
 * @param {(Object|Array)} data A JSON object or an array of them containing the data to convert. The whole object or each element of the array will be validated with the validator.
 * @param {Object} schema A json-schema defining the parameters of the data parameter.
 * @returns {Object} This function returns an image of the "data" parameter, coverted with the data type used by mongodb.
 */
function documentToDbFormat(data, schema) {
    return convertDocument(data, schema, valueToDbFormat)
}

/**
 * This function converts a json object that may contain mongodb types, into an equivalent JSON object.
 * @function
 * @param {(Object|Array)} data A JSON object containing the data returned by mongodb, with mongodb types.
 * @param {Object} schema A json-schema defining the parameters of the data parameter.
 * @returns {Object} This function returns an image of the "data" parameter, coverted with the data type used by mongodb.
 */
function dbFormatToDocument(data, schema) {
    return convertDocument(data, schema, dbFormatToValue)
}

/**
 * This function returns the data passed as **data** parameter.
 * @function
 * @param {object} data Anything you want.
 * @returns This function returns the *data* parameter.
 */
function equal(data) {
    return data
}

/**
 * This function returns nothing.
 * @function
 * @returns This function nothing.
 */
function none() {
    return
}

module.exports = { documentToDbFormat, dbFormatToDocument, equal, none }
