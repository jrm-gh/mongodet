'use strict'

const Ajv = require('ajv')
const { MongolError } = require('../errors')
const debug = false

function clone(obj) {
    var copy

    // Handle the 3 simple types, and null or undefined
    if (null === obj || 'object' !== typeof obj) return obj

    // Handle Date
    if (obj instanceof Date) {
        copy = new Date()
        copy.setTime(obj.getTime())
        return copy
    }

    // Handle Array
    if (obj instanceof Array) {
        copy = []
        for (var i = 0, len = obj.length; i < len; i++) {
            copy[i] = clone(obj[i])
        }
        return copy
    }

    // Handle Object
    if (obj instanceof Object) {
        copy = {}
        for (var attr in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, attr))
                copy[attr] = clone(obj[attr])
        }
        return copy
    }

    // eslint-disable-next-line prettier/prettier
    throw new MongolError('Unable to copy obj! Its type isn\'t supported.')
}

module.exports = {
    /**
     * This function validates one or several documents.
     * @param {object} data - A single or an array of documents in JSON (not in db) format.
     * @param {Ajv} validator - The validator used to validate the data.
     * @throws This function will throw an exception if the data is not validated (validator not set to 'skipValidation').
     */
    validateDocument(data, validator) {
        if (data.constructor.name === 'Array') {
            let ret = []
            for (let i = 0; i < data.length; i++) {
                if (validator)
                    if (!validator(data[i]))
                        throw new MongolError({
                            error: validator.errors,
                            document: data[i],
                            index: i
                        })
            }
            return ret
        } else {
            if (validator)
                if (!validator(data))
                    throw new MongolError({
                        error: validator.errors,
                        document: data
                    })
        }
    },

    /**
     *
     * @typedef {Object} validationData
     * @property {Object} insert
     * @property {Ajv} insert.validator - The validator used in insert mode.
     * @property {Object} insert.schema - The schema used in insert mode.
     * @property {Object} update
     * @property {Ajv} update.validator - The validator used in update mode.
     * @property {Object} update.schema - The schema used in update mode.
     */

    /**
     * This function returns a **validation** object containing the parameters required to validate data in insert and update modes.
     * @param {object} schema - A valid JSON schema. The following properties has been added or modified:
     * - **required**: this existing feature accepts now :
     * -- A single parameter: **required: 'a'** makes the 'a' property required in update and insert modes.
     * -- An array: **required: ['a', 'b' ]** makes the 'a' and 'b' properties required in update and insert modes.
     * -- An object: **required: { upsert: 'a', insert: ['b','c'], update: ['d', 'e']}** makes the 'a', 'b' and 'c' properties required in insert mode, and 'a', 'd' and 'e' proerties required in update mode.
     * - **unmodifiableProperties**: this new and optional feature, that can be placed at the same level as the **required** property defines which elements are not modifiable, and in which modes.
     * Note that this parameter and the "required" parameter can be used simultaneously but, if for a given mode, the same property is declared as required and unmodifiable, this function will throw an exception.
     * **NOTE:** the unmodifiableProperties setting works only if the additionalProperties parameter located at the same level is set to false
     * Examples:
     * -- **unmodifiableProperties: '_id'** makes the '_id' property unmodifiable in insert and update modes.
     * -- **unmodifiableProperties: ['_id', 'createdAt']** makes the specified properties unmodifiable in insert and update modes.
     * -- **unmodifiableProperties: { upsert: '_id', insert: ['a'], update: ['createdAt', 'country' }**: to make unmodifiable the ['_id', 'a'] properties in insert mode, and the ['_id', 'createdAt'] in update mode.
     * @throws This function trhows a **MongolError** exception if the same parameter is declared "required" and "unmodifiable" simultaneously.
     * @returns {validationData} This function returns the data required to validate with insert and update operations.
     */
    getValidationData(schema) {
        function getSchema(schema, mode) {
            function updateSubSchema(schema, path, level) {
                if (schema.$ref) {
                    // '#/definitions/address'
                    schema = clone(schema)
                    let ref = refSchema
                    schema.$ref
                        .replace('#/', '')
                        .split('/')
                        .map((p) => {
                            if (ref) ref = ref[p]
                        })
                    schema = { ...schema, ...ref }
                    delete schema.$ref
                }

                let ret = {}
                let properties = []
                let required

                if (schema.required) {
                    required = []
                    if (schema.required instanceof Array) {
                        required = schema.required.slice()
                    } else if (schema.required instanceof Object) {
                        if (schema.required.upsert)
                            required = required.concat(schema.required.upsert)
                        if (schema.required[mode])
                            required = required.concat(schema.required[mode])
                    } else {
                        required.push(schema.required)
                    }
                }

                if (schema.properties) {
                    properties = Object.keys(schema.properties)
                    if (schema.unmodifiableProperties) {
                        let unmodifiableProperties = []
                        if (schema.unmodifiableProperties instanceof Array) {
                            unmodifiableProperties = unmodifiableProperties.concat(
                                schema.unmodifiableProperties
                            )
                        } else if (
                            schema.unmodifiableProperties instanceof Object
                        ) {
                            // console.log(schema.unmodifiableProperties)
                            if (schema.unmodifiableProperties.upsert)
                                unmodifiableProperties = unmodifiableProperties.concat(
                                    schema.unmodifiableProperties.upsert
                                )
                            if (schema.unmodifiableProperties[mode])
                                unmodifiableProperties = unmodifiableProperties.concat(
                                    schema.unmodifiableProperties[mode]
                                )
                        } else {
                            unmodifiableProperties = unmodifiableProperties.concat(
                                schema.unmodifiableProperties
                            )
                        }
                        if (debug) {
                            console.log('Unmodifiable properties:')
                            console.log(unmodifiableProperties)
                            console.log()
                        }

                        properties = properties.filter(
                            (p) => unmodifiableProperties.indexOf(p) === -1
                        )

                        required.map((r) => {
                            if (unmodifiableProperties.indexOf(r) >= 0)
                                throw new MongolError(
                                    `Property "${r}" in "${path}", can not be declared as unmodifiable and required. Current mode: "${mode}".`
                                )
                        })
                        if (schema.additionalProperties !== false) {
                            const msg = `Error in "${path}": if the parameter "unmodifiableProperties" is set, the "additionalProperties" parameter must be set to false on the same level.`
                            throw new MongolError(msg)
                        }
                    }
                }

                for (const key in schema) {
                    if (Object.prototype.hasOwnProperty.call(schema, key)) {
                        if (debug)
                            console.log(`>> ${''.padEnd(level, '\t')} ${key}`)

                        switch (key) {
                            case 'properties':
                                ret.properties = {}
                                if (debug)
                                    console.log(`    properties: ${properties}`)
                                for (const property in schema.properties) {
                                    if (
                                        Object.prototype.hasOwnProperty.call(
                                            schema.properties,
                                            property
                                        )
                                    ) {
                                        if (debug)
                                            console.log(
                                                `>> ${''.padEnd(
                                                    level,
                                                    '\t'
                                                )} -> PROP ${property}`
                                            )

                                        if (properties.indexOf(property) >= 0) {
                                            if (debug)
                                                console.log(
                                                    `        --->>> prop ${property}`
                                                )
                                            ret.properties[
                                                property
                                            ] = updateSubSchema(
                                                schema.properties[property],
                                                `${path}.properties.${property}`,
                                                level + 1
                                            )
                                        }
                                    }
                                }
                                break

                            case 'items':
                                if (schema.items instanceof Array) {
                                    ret.items = []
                                    for (
                                        let i = 0;
                                        i < schema.items.length;
                                        i++
                                    )
                                        ret.items[i] = updateSubSchema(
                                            schema.items[i],
                                            `${path}.items[${i}]`,
                                            level + 1
                                        )
                                } else {
                                    ret.items = updateSubSchema(
                                        schema.items,
                                        `${path}.items`,
                                        level + 1
                                    )
                                }
                                break

                            case 'required':
                                if (required) ret.required = required
                                break

                            case 'definitions':
                            case 'unmodifiableProperties':
                                break

                            default:
                                ret[key] = clone(schema[key])
                                break
                        }
                    }
                }

                return ret
            }

            const refSchema = schema
            return updateSubSchema(schema, 'schema', 0)
        }

        const ajv = new Ajv()
        const insertSchema = getSchema(schema, 'insert')
        const updateSchema = getSchema(schema, 'update')

        return {
            insert: {
                schema: insertSchema,
                validator: ajv.compile(insertSchema)
            },
            update: {
                schema: updateSchema,
                validator: ajv.compile(updateSchema)
            }
        }
    }
}
