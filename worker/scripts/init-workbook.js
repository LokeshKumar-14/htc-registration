import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWorkbook } from "../src/index.js";

const outputPath = resolve(process.argv[2] || "HTC_Registrations.xlsx");
const workbook = await createWorkbook();
await workbook.xlsx.writeFile(outputPath);
console.log(`Created private-repository workbook template: ${outputPath}`);
