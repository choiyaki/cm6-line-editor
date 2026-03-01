export function buildExportText(doc) {
    const fullText = doc.toString();
    return removeMarkedBlocks(fullText);
}

export function removeMarkedBlocks(text) {
    const blocks = text.split(/\n\s*\n/);
    const cleanedBlocks = blocks.filter(block => {
        const firstLine = block.split("\n")[0] ?? "";
        return !(
            firstLine.includes("📝") ||
            firstLine.includes("📓")
        );
    });
    return cleanedBlocks.join("\n\n");
}
