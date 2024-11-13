import { $, echo } from "zx"

export const die = (msg, exitCode = 1, err = null) => {
  if (err) {
    if (typeof err.printStackTrace === "function") {
      err.printStackTrace()
    } else {
      err.toString()
    }
  }
  
  echo`ERROR: ${msg}`
  process.exit(exitCode)
}

export const assertFatal = (test, msg, exitCode = 1, err = null) => {
  if (test)
    return
  
  die(msg, exitCode, err)
}

export const run = (...args) => {
  echo`Running: ${args.join(" ")}`
  return $`${args}`.catch((err) =>
    die(
      `An error occurred while executing: ${args.join(" ")}: ${err.message}`,
      1,
      err
    )
  )
}
