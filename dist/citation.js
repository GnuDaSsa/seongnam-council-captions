/* 자막을 복사하거나 문서로 내려받을 때 출처(발언자·회의·시각·검수 상태·장면 링크)를 붙인다. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CouncilCitation = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();

  function kst(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    // 브라우저·Node마다 ko-KR 표기가 달라 부품을 받아 고정 형식으로 조립한다
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Seoul', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'})
      .formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  /** 생중계 자막 한 줄을 가리키는 장면 링크. 기존 ?live=<회의>&cue=<기록> 딥링크를 쓴다. */
  function liveLink(base, meetingId, cueId) {
    const url = new URL(base);
    url.search = '';
    url.hash = '';
    url.searchParams.set('live', String(meetingId));
    if (cueId != null && cueId !== '') url.searchParams.set('cue', String(cueId));
    return url.toString();
  }

  /** 출처 두 줄을 만든다. 발언자를 모르면 '발언자 미확인'으로 적는다. */
  function citation({speaker, meeting, time, review, url}) {
    const who = clean(speaker) || '발언자 미확인';
    const where = clean(meeting) || '성남시의회 회의';
    const parts = [who, [where, clean(time)].filter(Boolean).join(' ')];
    const state = clean(review) || '음성인식 자막 · 검수 전';
    return `출처: ${parts.join(' · ')} (${state})` + (url ? `\n${url}` : '');
  }

  /** 선택한 글과 출처를 합친 복사 내용. 선택이 비면 null. */
  function copied(selection, info) {
    const text = String(selection ?? '').trim();
    if (!text) return null;
    return `“${text}”\n${citation(info)}`;
  }

  /** 내려받는 문서 맨 위에 넣을 출처 주소와 내려받은 때. */
  function downloadHeader(url, at = new Date()) {
    const lines = [];
    if (url) lines.push(`출처 주소  ${url}`);
    const when = kst(at);
    if (when) lines.push(`내려받은 때  ${when} (한국시간)`);
    return lines;
  }

  /**
   * 브라우저 전용: container 안에서 복사하면 출처를 붙인다.
   * resolve(element)는 data-cue-id가 있는 줄 요소를 받아 citation()에 넘길 정보를 돌려준다.
   */
  function attachCopy(container, resolve) {
    if (!container || typeof resolve !== 'function') return;
    container.addEventListener('copy', event => {
      const selection = container.ownerDocument.getSelection();
      if (!selection || selection.isCollapsed || !event.clipboardData) return;
      const anchor = selection.anchorNode && (selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement);
      const line = anchor && anchor.closest('[data-cue-id]');
      if (!line || !container.contains(line)) return;
      const info = resolve(line);
      const text = info && copied(selection.toString(), info);
      if (!text) return;
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
    });
  }

  return Object.freeze({kst, liveLink, citation, copied, downloadHeader, attachCopy});
});
