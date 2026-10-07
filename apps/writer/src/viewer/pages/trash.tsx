/** @jsxImportSource hono/jsx */
import type { Context } from "hono";

import type { HttpServices } from "../../http.js";
import { Layout } from "../layout.js";
import { noStore } from "../respond.js";

export async function trashPage(s: HttpServices, c: Context): Promise<Response> {
  const items = await s.reads.deletedCollections();
  return noStore(
    c.html(
      <Layout title="Trash">
        <main class="wrap">
          <h1>Trash</h1>
          <p class="muted">Deleted collections can be restored or permanently purged.</p>
          <p class="error" data-error role="alert"></p>
          <div class="list">
            {items.length ? (
              items.map((item) => (
                <div class="row">
                  <span class="row-title">
                    {item.title}
                    <small> · {item.id}</small>
                  </span>
                  <button data-action="undelete" data-id={item.id}>
                    Undelete {item.title}
                  </button>
                  <button class="danger" data-action="purge" data-id={item.id}>
                    Purge {item.title}
                  </button>
                </div>
              ))
            ) : (
              <div class="row muted">Trash is empty.</div>
            )}
          </div>
        </main>
      </Layout>,
    ),
  );
}
