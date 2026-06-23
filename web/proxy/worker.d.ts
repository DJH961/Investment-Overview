/**
 * Minimal ambient types for the Cloudflare Worker module so the TypeScript test
 * suite can import it. The Worker itself ships as plain JS (deployed by wrangler);
 * this declaration only describes its `fetch` entrypoint for the tests.
 */
export interface WorkerEnv {
  RELEASE_URL?: string;
  META_URL?: string;
  TIINGO_TOKEN?: string;
  TIINGO_HOURLY_RESERVE?: string;
}

declare const worker: {
  fetch(request: Request, env: WorkerEnv): Promise<Response>;
};

export default worker;
