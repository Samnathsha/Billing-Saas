import { headers } from "next/headers";
import { getRequestContext, PermissionDeniedError } from "@/modules/auth";
import { FileError, readImage } from "@/modules/files";

// An uploaded image, only for logged-in members of the business it belongs
// to (row-level security finds nothing for anyone else).
export async function GET(_request: Request, { params }: RouteContext<"/api/files/[id]">): Promise<Response> {
  const who = await getRequestContext(await headers());
  if (who.kind !== "member") return new Response("Not found", { status: 404 });
  try {
    const { id } = await params;
    const file = await readImage(who.ctx, { fileId: id });
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.contentType,
        "Cache-Control": "private, max-age=300",
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof FileError || error instanceof PermissionDeniedError || (error instanceof Error && error.name === "ZodError")) {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
}
