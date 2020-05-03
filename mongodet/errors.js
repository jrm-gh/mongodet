'use strict'

class MongolError {
    constructor(error) {
        this.errorType = this.constructor.name
        if (error.constructor.name === 'Object') {
            for (const p in error)
                if (Object.prototype.hasOwnProperty.call(error, p))
                    this[p] = error[p]
        } else {
            this.error = error
        }
        this.stack = new Error().stack.split('\n')
    }
}

module.exports = { MongolError }
