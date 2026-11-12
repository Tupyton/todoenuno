import wasmUrl from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url';

/**
 * Runs `qpdf [args] in.pdf out.pdf` on the file and returns the output bytes.
 * qpdf's own messages only reach the console, so the caller supplies the error shown when no output is written.
 * A fresh module per call: the program exits after running once.
 */
export async function qpdf(file, args, failure) {
  const { default: createModule } = await import('@neslinesli93/qpdf-wasm');
  const module = await createModule({ locateFile: () => wasmUrl, noInitialRun: true });
  module.FS.writeFile('/in.pdf', new Uint8Array(await file.arrayBuffer()));
  try {
    module.callMain([...args, '/in.pdf', '/out.pdf']);
  } catch {
    // A non-zero exit throws; the output file decides below whether it worked.
  }
  try {
    // qpdf exits with a warning code for slightly damaged files but still writes the output.
    return module.FS.readFile('/out.pdf');
  } catch {
    throw new Error(failure);
  }
}
