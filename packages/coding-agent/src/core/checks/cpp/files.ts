import { extname } from "node:path";

const CPP_HIP_SOURCE_EXTENSIONS = new Set([".cpp", ".cc", ".cxx", ".c", ".cu", ".hip"]);
const CPP_HIP_HEADER_EXTENSIONS = new Set([".h", ".hh", ".hpp", ".hxx", ".cuh", ".hiph"]);

export function isCppOrHipSource(filePath: string): boolean {
	return CPP_HIP_SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function isCppOrHipHeader(filePath: string): boolean {
	return CPP_HIP_HEADER_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function isCppOrHipFile(filePath: string): boolean {
	return isCppOrHipSource(filePath) || isCppOrHipHeader(filePath);
}
