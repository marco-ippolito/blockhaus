import { readFileSync } from "node:fs";

export const key = readFileSync(new URL("./key.pem", import.meta.url), "utf8");
export const cert = readFileSync(
	new URL("./cert.pem", import.meta.url),
	"utf8",
);
