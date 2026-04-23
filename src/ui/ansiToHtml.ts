// 외부 라이브러리 기반 ANSI → HTML 변환 (모든 ANSI 지원)
import AnsiToHtml from "ansi-to-html";
import stripAnsi from "strip-ansi";


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

// ANSI 코드 제거 유틸도 export
export { stripAnsi };
