export function renameMediaFile(media, value) {
  const extension = String(
    media.extension || media.filename.split(".").pop(),
  ).toLowerCase();
  let filename = String(value || "").trim();
  if (!filename || filename.length > 180 || /[\\/\x00-\x1f]/.test(filename))
    throw new Error(
      "Enter a file name without folders or control characters (up to 180 characters).",
    );
  if (!filename.includes(".")) filename += `.${extension}`;
  if (filename.split(".").pop().toLowerCase() !== extension)
    throw new Error(
      `Keep the .${extension} extension when renaming this file.`,
    );
  const name = filename.slice(0, -extension.length - 1).trim();
  if (!name) throw new Error("The file name cannot be empty.");
  return {
    name,
    filename,
    aliases: [
      ...new Set(
        [...(media.aliases || []), media.filename].filter(
          (v) => v && v !== filename,
        ),
      ),
    ],
  };
}
