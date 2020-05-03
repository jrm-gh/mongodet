'use strict'

////////////////////////////////////////////////////////////////////////////////
// Requiresments of this module
////////////////////////////////////////////////////////////////////////////////

const {
    ObjectId,
    Int32,
    Long,
    Decimal128,
    Binary
    // ISODate,
} = require('mongodb')

////////////////////////////////////////////////////////////////////////////////
// Variables of this module
////////////////////////////////////////////////////////////////////////////////

let toDbFunctions = {}
let fromDbFunctions = {}

////////////////////////////////////////////////////////////////////////////////
// Functions of this module
////////////////////////////////////////////////////////////////////////////////

// Exported functions

/**
 * This function adds a mongodb type.
 * @param {string} type The name of the type. This name must correspond with the mongoType defined in the collection schemas.
 * @param {function} toDb A function that converts a single element into a mongodb data value.
 * @param {function} fromDb A function that converts a mongodb data value into a number or string.
 * @returns {void}
 */
function addType(type, toDb, fromDb) {
    toDbFunctions[type] = toDb
    fromDbFunctions[type] = fromDb
}

/**
 * This function converts a value (number or string) into an specific mongodb object (ObjectId, Long ...).
 * @param {(string|number)} value
 * @param {string} type The name of the type.
 * @param {string} encoding This parameter is by now only used by the 'binary' data type and can have one of the values allowed by the Buffer.from(...,encoding) parameter ('hex', 'latin1' ...).
 * @returns {object} This function returns an object that mongodb recognizes (ObjectId, Long ...).
 */
function valueToDbFormat(value, type, encoding) {
    if (typeof toDbFunctions[type] === 'function')
        return toDbFunctions[type](value, encoding)
    return value
}

/**
 * This function converts an specific mongodb object (ObjectId, Long ...) a value (number or string) into an .
 * @param {Object} value A specific mongodb object (ObjectId, Long ...) that will be converted into a string or number.
 * @param {string} type The name of the type.
 * @param {string} encoding This parameter is not used.
 * @returns {(string|number)} This function returns a string or a number.
 */
function dbFormatToValue(value, type, encoding) {
    if (typeof fromDbFunctions[type] === 'function')
        return fromDbFunctions[type](value, encoding)
    return value
}

// Conversion functions

function numericStringToBuffer(str) {
    let radix, nb
    if (str.startsWith('0x')) {
        str = str.slice(2)
        radix = 16
        nb = 2
    } else if (str.startsWith('b')) {
        str = str.slice(1)
        radix = 2
        nb = 8
    } else {
        throw `Invalid value ${str}. Only hexadecimal and decimal values are managed by this function`
    }

    let buffer = Buffer.alloc((str.length + nb - 1) / nb)
    let cnt = 0
    buffer[cnt++] = parseInt(str.slice(-nb), radix)
    for (var i = nb; i < str.length; i += nb) {
        buffer[cnt++] = parseInt(str.slice(-(nb + i), -i), radix)
    }
    return buffer
}

////////////////////////////////////////////////////////////////////////////////
// Adding conversion functions
////////////////////////////////////////////////////////////////////////////////

addType(
    'objectId',
    (data) => new ObjectId(data),
    (data) => data.toString()
)

addType(
    'int32',
    (data) => new Int32(parseInt(data)),
    (data) => data.value
)

addType(
    'int64',
    (data) => {
        if (typeof data === 'string') {
            let i64 = data.toLocaleLowerCase()
            if (i64.startsWith('0x')) {
                return Long.fromString(i64.slice(2), 16)
            } else if (data.startsWith('b')) {
                return Long.fromString(i64.slice(1), 2)
            } else {
                return Long.fromString(i64, 10)
            }
        } else {
            return Long.fromNumber(data)
        }
    },
    (data) => {
        // Warning: the output format should be taken into account here
        return data.toInt()
    }
)

addType(
    'int128',
    (data) => {
        if (typeof data === 'string') {
            let i128 = data.toLocaleLowerCase()
            if (i128.startsWith('0x') || i128.startsWith('b')) {
                let buf = numericStringToBuffer(data)
                return new Decimal128(buf)
            } else {
                return Decimal128.fromString(i128)
            }
        } else if (typeof data === 'number') {
            let buf = Buffer.alloc(16)
            buf.writeBigInt64LE(BigInt(data))
            return new Decimal128(buf)
        } else if (data.constructor.name === 'Buffer') {
            return new Decimal128(data)
        } else {
            throw 'Unable to convert to 128bit'
        }
    },
    (data) => {
        // Returs a string of type "0xffa9d01"
        let i = data.bytes.length - 1

        while (!data.bytes[i] && i >= 0) i--

        if (i < 0) return '0x00'

        let str = '0x'
        while (i >= 0) {
            str += data.bytes[i].toString(16).padStart(2, '00')
            i--
        }
        return str
    }
)

addType(
    'binary',
    (data, encoding) => new Binary(Buffer.from(data, encoding)),
    (data, encoding) => data.buffer.toString(encoding)
)

addType(
    'date',
    (data) => (data ? new Date(data) : new Date()),
    (data) => data
)

////////////////////////////////////////////////////////////////////////////////
// Exporting data
////////////////////////////////////////////////////////////////////////////////

module.exports = { addType, valueToDbFormat, dbFormatToValue }
