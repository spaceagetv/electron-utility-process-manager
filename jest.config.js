
const { defaults: tsjPreset } = require('ts-jest/presets');

module.exports = {
    verbose: true,
    testMatch: ["**/dist/**/*.spec.js"],
    moduleDirectories: [
      "node_modules",
      "dist"
    ],

    transform: {

    },
    moduleFileExtensions: [
      "ts",
      "tsx",
      "js"
    ]
  }