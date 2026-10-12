import { measureProgram, MEASURE_DEFAULTS } from "../src/measure.js";
const o = { ...MEASURE_DEFAULTS, fast: 200, slow: 25, ...JSON.parse(process.argv[2]) };
process.stdout.write(measureProgram(o));
