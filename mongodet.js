'use strict'

module.exports = {
    ...require('./mongodet/connexion'),
    ...require('./mongodet/Collection'),
    ...require('./mongodet/conversion'),
    ...require('./mongodet/settings'),
    ...require('./mongodet/errors')
}
