/**
 * Transaction helpers
 * Controllers use prisma.transaction directly; import helpers from here.
 */

const generateTxId = () => 'TX' + Date.now() + Math.floor(Math.random() * 1000);

module.exports = { generateTxId };
