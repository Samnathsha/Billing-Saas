import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { cleanImage, ImageError, MAX_UPLOAD_BYTES } from "./images";

const png = (w = 20, h = 10) => sharp({ create: { width: w, height: h, channels: 3, background: "#3366cc" } }).png().toBuffer();

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "ok";
  } catch (error) {
    return error instanceof ImageError ? error.code : String(error);
  }
}

describe("cleanImage", () => {
  it("accepts PNG, JPEG and WebP and re-encodes to WebP", async () => {
    for (const make of [png, () => sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).jpeg().toBuffer(), () => sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).webp().toBuffer()]) {
      const out = await cleanImage(await make());
      expect(out.contentType).toBe("image/webp");
      expect(out.bytes.subarray(8, 12).toString("latin1")).toBe("WEBP");
      expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("refuses a renamed program (an .exe is not an image, whatever its name)", async () => {
    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200, 0x90)]);
    expect(await codeOf(cleanImage(exe))).toBe("NOT_AN_IMAGE");
  });

  it("refuses a file that only starts like a PNG", async () => {
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("<script>alert(1)</script>")]);
    expect(await codeOf(cleanImage(fake))).toBe("NOT_AN_IMAGE");
  });

  it("refuses SVG, GIF, text and empty files", async () => {
    expect(await codeOf(cleanImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBe("NOT_AN_IMAGE");
    expect(await codeOf(cleanImage(Buffer.from("GIF89a\u0001\u0000\u0001\u0000")))).toBe("NOT_AN_IMAGE");
    expect(await codeOf(cleanImage(Buffer.from("hello")))).toBe("NOT_AN_IMAGE");
    expect(await codeOf(cleanImage(Buffer.alloc(0)))).toBe("EMPTY");
  });

  it("refuses files over 2 MB before reading them", async () => {
    const big = Buffer.concat([await png(), Buffer.alloc(MAX_UPLOAD_BYTES)]);
    expect(await codeOf(cleanImage(big))).toBe("TOO_LARGE");
  });

  it("strips metadata and data appended after the image", async () => {
    const withExif = await sharp({ create: { width: 30, height: 30, channels: 3, background: "#123" } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: "SECRET-GPS-OWNER" } } })
      .toBuffer();
    const smuggled = Buffer.concat([withExif, Buffer.from("APPENDED-PAYLOAD")]);
    const out = await cleanImage(smuggled);
    expect(out.bytes.toString("latin1")).not.toContain("SECRET-GPS-OWNER");
    expect(out.bytes.toString("latin1")).not.toContain("APPENDED-PAYLOAD");
    expect((await sharp(out.bytes).metadata()).exif).toBeUndefined();
  });

  it("shrinks large pictures to at most 1600 pixels", async () => {
    const out = await cleanImage(await png(3200, 800));
    expect([out.width, out.height]).toEqual([1600, 400]);
  });
});
