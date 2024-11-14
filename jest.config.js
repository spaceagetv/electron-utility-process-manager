
const { defaults: tsjPreset } = require('ts-jest/presets');

module.exports = {
    verbose: true,
    testMatch: ["**/lib/cjs/**/*.spec.js"],
    moduleDirectories: [
      "node_modules",
      "lib/cjs"
    ],
    
    transform: {
    
    },
    moduleFileExtensions: [
      "ts",
      "tsx",
      "js"
    ]
  }