/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";

import { clientAsset, cssAsset } from "./assets.js";

const favicon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2159a4"/><path d="M13 18l11 29 8-17 8 17 11-29" fill="none" stroke="white" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>')}`;
export function Layout(props: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · Waypoint</title>
        <link rel="icon" href={favicon} />
        <link rel="stylesheet" href={cssAsset.url} />
      </head>
      <body>
        <header>
          <a class="brand" href="/">
            Waypoint
          </a>
          <nav class="nav">
            <a href="/">Collections</a>
            <a href="/trash">Trash</a>
            <a href="/status">Status</a>
          </nav>
        </header>
        {props.children}
        <script src={clientAsset.url} defer />
      </body>
    </html>
  );
}
export function ErrorPage() {
  return (
    <Layout title="Not found">
      <main class="wrap">
        <h1>Page not found</h1>
        <p>This collection, revision, or file could not be found.</p>
        <a href="/">Back to collections</a>
      </main>
    </Layout>
  );
}
