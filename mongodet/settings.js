'use strict'

let settings = {}

/**
 * This function sets key/values pairs and may be used by this library.
 * @param {string} key The key.
 * @param {any} value The value.
 */
function set(key, value) {
    // console.log (`Setting value "${value}" to key "${key}"`)
    settings[key] = value
}

module.exports = { settings, set }
