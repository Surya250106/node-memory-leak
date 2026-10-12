import fs from 'node:fs';
import path from 'node:path';

export function validateHeapSnapshot(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    throw new Error(`Snapshot file is empty: ${filePath}`);
  }

  // Open file for streaming validation
  const fd = fs.openSync(filePath, 'r');
  const bufferSize = 64 * 1024; // 64KB read chunks
  const buffer = Buffer.alloc(bufferSize);

  let bytesRead = 0;
  let position = 0;
  let foundSnapshot = false;
  let foundNodes = false;
  let foundEdges = false;
  let foundStrings = false;

  // Stream through the file in chunks without loading entire multi-megabyte file at once
  while ((bytesRead = fs.readSync(fd, buffer, 0, bufferSize, position)) > 0) {
    const chunk = buffer.toString('utf8', 0, bytesRead);

    if (!foundSnapshot && chunk.includes('"snapshot"')) foundSnapshot = true;
    if (!foundNodes && chunk.includes('"nodes"')) foundNodes = true;
    if (!foundEdges && chunk.includes('"edges"')) foundEdges = true;
    if (!foundStrings && chunk.includes('"strings"')) foundStrings = true;

    if (foundSnapshot && foundNodes && foundEdges && foundStrings) {
      break;
    }

    position += bytesRead;
  }

  // Validate start of file begins with '{'
  const headBuf = Buffer.alloc(128);
  fs.readSync(fd, headBuf, 0, 128, 0);
  const headStr = headBuf.toString('utf8').trim();
  const startsWithBrace = headStr.startsWith('{');

  // Validate end of file terminates with '}'
  const tailSize = Math.min(1024, stat.size);
  const tailBuf = Buffer.alloc(tailSize);
  fs.readSync(fd, tailBuf, 0, tailSize, stat.size - tailSize);
  fs.closeSync(fd);

  const tailStr = tailBuf.toString('utf8').trim();
  const endsWithBrace = tailStr.endsWith('}');

  const isValid = startsWithBrace && endsWithBrace && foundSnapshot && foundNodes && foundEdges && foundStrings;

  return {
    filePath,
    sizeBytes: stat.size,
    sizeMB: (stat.size / (1024 * 1024)).toFixed(2),
    startsWithBrace,
    endsWithBrace,
    hasSnapshotKey: foundSnapshot,
    hasNodesKey: foundNodes,
    hasEdgesKey: foundEdges,
    hasStringsKey: foundStrings,
    isValid,
  };
}

// If run directly
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain || process.argv[1]?.includes('validate-snapshots')) {
  const files = ['snapshots/before.heapsnapshot', 'snapshots/after.heapsnapshot'];
  let allValid = true;

  for (const file of files) {
    try {
      const result = validateHeapSnapshot(file);
      console.log(`Validated: ${file}`);
      console.log(`  Size:           ${result.sizeMB} MB (${result.sizeBytes} bytes)`);
      console.log(`  Valid JSON root: Starts '{': ${result.startsWithBrace}, Ends '}': ${result.endsWithBrace}`);
      console.log(`  Required keys:  snapshot: ${result.hasSnapshotKey}, nodes: ${result.hasNodesKey}, edges: ${result.hasEdgesKey}, strings: ${result.hasStringsKey}`);
      console.log(`  Status:         ${result.isValid ? 'PASSED' : 'FAILED'}\n`);
      if (!result.isValid) allValid = false;
    } catch (err) {
      console.error(`Validation failed for ${file}: ${err.message}`);
      allValid = false;
    }
  }

  process.exit(allValid ? 0 : 1);
}
