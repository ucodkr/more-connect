// ANSI to HTML conversion through the external library.
import AnsiToHtml from "ansi-to-html";
import stripAnsi from "strip-ansi";

const ansiCsiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ansiOscPattern = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ansiSingleCharPattern = /\u001b[@-_]/g;
const c1CsiPattern = /\u009b[0-?]*[ -/]*[@-~]/g;
const otherControlPattern = /[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f-\u009f]/g;

export function normalizeAnsiDisplayLine(text: string): string {
    const segments = String(text ?? "").split("\r");
    const visibleSegment = segments.at(-1) ?? "";
    return visibleSegment
        .replaceAll(ansiOscPattern, "")
        .replaceAll(ansiCsiPattern, "")
        .replaceAll(c1CsiPattern, "")
        .replaceAll(ansiSingleCharPattern, "")
        .replaceAll(otherControlPattern, "");
}

// Convert the full text at once so colors and line breaks remain intact.
export function ansiToHtml(text: string): string {
    const converter = new AnsiToHtml({
        fg: '#d4d4d4',
        bg: '#1e1e1e',
        newline: false, // line breaks are handled separately
        escapeXML: true,
        stream: false
    });
    return converter.toHtml(text);
}

export function ansiLinesToHtml(lines: string[]): string[] {
    const converter = new AnsiToHtml({
        fg: "#d4d4d4",
        bg: "#1e1e1e",
        newline: false,
        escapeXML: true,
        stream: true
    });
    return lines.map((line) => converter.toHtml(normalizeAnsiDisplayLine(line)));
}

// Re-export the ANSI stripping utility.
export { stripAnsi };
