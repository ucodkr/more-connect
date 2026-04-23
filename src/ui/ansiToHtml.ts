// 외부 라이브러리 기반 ANSI → HTML 변환 (모든 ANSI 지원)
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

// 줄 단위가 아니라 전체 텍스트를 한 번에 변환해야 색상/줄바꿈이 깨지지 않음
export function ansiToHtml(text: string): string {
    const converter = new AnsiToHtml({
        fg: '#d4d4d4',
        bg: '#1e1e1e',
        newline: false, // 줄바꿈 직접 처리
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

// ANSI 코드 제거 유틸도 export
export { stripAnsi };
