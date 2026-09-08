import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/** An offline fixture, deliberately separate from either vendor's API or UI. */
export function createDemoSite() {
  return createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Document lab — test fixture</title>
      <style>body{font:17px system-ui;max-width:760px;margin:60px auto;padding:24px;background:#fafafa;color:#20242a}label{display:block;margin:24px 0}input,button{font:inherit;padding:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:20px}small{color:#586070}</style>
      <main><h1>Document lab</h1><p>This local fixture reads a text file. It does not call Powder, Reducto, or an AI API.</p>
      <form id="parse-form"><label>Document <input name="document" type="file" required></label>
      <label>Page range <input name="page_range" placeholder="1-3"></label><button type="submit">Parse document</button></form>
      <p role="status" id="status">Ready</p><h2>Complete JSON result</h2><pre data-testid="parse-result" id="result">null</pre>
      <a id="download" hidden download="parse-result.json">Download JSON</a><p><small>Upload only synthetic test content.</small></p></main>
      <script>
        document.querySelector('#parse-form').addEventListener('submit',async(event)=>{
          event.preventDefault();
          const file=document.querySelector('[name=document]').files[0];
          if(!file)return;
          const status=document.querySelector('#status');status.textContent='Processing';
          const result={document_id:crypto.randomUUID(),chunks:[{text:await file.text()}]};
          const json=JSON.stringify(result,null,2);document.querySelector('#result').textContent=json;
          const download=document.querySelector('#download');
          if(download.href.startsWith('blob:'))URL.revokeObjectURL(download.href);
          download.href=URL.createObjectURL(new Blob([json],{type:'application/json'}));download.hidden=false;
          status.textContent='Complete';
        });
      </script></html>`);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createDemoSite();
  server.listen(8787, "127.0.0.1", () =>
    process.stderr.write("Synthetic document fixture: http://127.0.0.1:8787\n"),
  );
  const close = () => server.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
