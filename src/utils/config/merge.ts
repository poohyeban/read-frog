import { deepmergeCustom } from "deepmerge-ts"

/** Configuration arrays replace prior values; object patches retain legacy merge semantics. */
export const mergeWithArrayOverwrite = deepmergeCustom({
  mergeArrays: (values) => values[values.length - 1],
})
