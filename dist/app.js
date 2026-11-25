(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className)
      node.className = className;
    if (value != null)
      node.textContent = value;
    return node;
  };
  const state = {
    meetings: [],
    selected: null,
    edits: {}
  };
  const storageKey = 'council-private-edits-v1';
  let toastTimer;
  function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3200);
  }
  try {
    state.edits = JSON.parse(localStorage.getItem(storageKey) || '{}') || {};
  } catch {
    state.edits = {};
  }
  function safeUrl(value) {
    try {
      if (typeof value !== 'string' || !value.trim())
        return null;
      const url = new URL(value);
      return [
        'http:',
        'https:'
      ].includes(url.protocol) ? url : null;
    } catch {
      return null;
    }
  }
  function seconds(value) {
    if (typeof value === 'number')
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
    const text = String(value ?? '').trim();
    if (/^\d+(\.\d+)?$/.test(text))
      return Math.floor(Number(text));
    const parts = text.split(':');
    if (parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p)))
      return null;
    return Math.floor(parts.reduce((sum, part) => sum * 60 + Number(part), 0));
  }
  function timestamp(value) {
    const s = seconds(value);
    if (s === null)
      return String(value || '원문');
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    return [
      h,
      m,
      sec
    ].map(n => String(n).padStart(2, '0')).join(':');
  }
  function playbackUrl(segment, meeting) {
    const url = safeUrl(segment.sourceUrl || meeting.sourceUrl);
    if (!url)
      return null;
    const s = seconds(segment.start);
    if (s !== null && !segment.sourceUrl) {
      if (url.hostname === 'cast.sncouncil.go.kr' && url.pathname.endsWith('/vod/vod_view.jsp'))
        url.searchParams.set('position', String(s));
      else if (/youtube\.com$|youtu\.be$/i.test(url.hostname))
        url.searchParams.set('t', String(s));
      else
        url.hash = `t=${ s }`;
    }
    return url.href;
  }
  function editFor(meeting, segment) {
    return state.edits[String(meeting._workspaceKey || meeting.id)]?.[String(segment.id)] || {};
  }
  function editedMeeting(meeting) {
    return {
      ...meeting,
      segments: (meeting.segments || []).map(segment => {
        const edit = editFor(meeting, segment);
        return Object.keys(edit).length ? {
          ...segment,
          originalText: segment.text,
          originalSpeaker: segment.speaker,
          originalStatus: segment.status,
          ...edit,
          status: '브라우저 수정본'
        } : { ...segment };
      })
    };
  }
  function textMatches(value, query) {
    return String(value ?? '').toLocaleLowerCase('ko').includes(query);
  }
  function renderList() {
    const query = $('meeting-search').value.trim().toLocaleLowerCase('ko');
    const matches = state.meetings.filter(m => [
      m.title,
      m.date,
      m.body,
      ...m.agenda || [],
      ...editedMeeting(m).segments.flatMap(s => [
        s.speaker,
        s.text
      ])
    ].some(v => textMatches(v, query)));
    $('meeting-count').textContent = state.meetings.length;
    $('list-count').textContent = `${ matches.length }건`;
    const list = $('meeting-list');
    list.replaceChildren();
    if (!matches.length) {
      list.append(el('div', 'empty-results', state.meetings.length ? '검색 결과가 없습니다.' : '등록된 회의가 없습니다.'));
      return;
    }
    matches.forEach(m => {
      const button = el('button', `meeting-card${ state.selected === m ? ' active' : '' }`);
      button.type = 'button';
      if (state.selected === m)
        button.setAttribute('aria-current', 'true');
      button.append(el('span', 'date', m.date || '날짜 미상'), el('strong', '', m.title || '제목 없는 회의'), el('span', 'body', m.body || '회의'));
      button.addEventListener('click', () => {
        state.selected = m;
        const q = $('meeting-search').value.trim();
        $('speech-search').value = q && editedMeeting(m).segments.some(s => [
          s.speaker,
          s.text
        ].some(v => textMatches(v, q.toLocaleLowerCase('ko')))) ? q : '';
        renderList();
        renderDetail();
        if (window.matchMedia('(max-width: 800px)').matches)
          $('detail-content').scrollIntoView({
            behavior: 'smooth',
            block: 'start'
          });
      });
      list.append(button);
    });
  }
  function sourceLink(id, url) {
    const a = $(id), safe = safeUrl(url);
    a.hidden = !safe;
    if (safe)
      a.href = safe.href;
    else
      a.removeAttribute('href');
  }
  function renderDetail() {
    const m = state.selected;
    $('detail-empty').hidden = !!m;
    $('detail-content').hidden = !m;
    if (!m)
      return;
    $('crumb').textContent = m.title || '회의';
    $('meeting-title').textContent = m.title || '제목 없는 회의';
    $('meeting-meta').textContent = [
      m.date,
      m.body
    ].filter(Boolean).join('  \xB7  ');
    const badges = $('meeting-badges');
    badges.replaceChildren(el('span', 'badge', '공개 자료'), el('span', 'badge neutral', m.coverage || '발언 발췌\xB7검토용'));
    sourceLink('source-link', m.sourceUrl);
    sourceLink('minutes-link', m.minutesUrl);
    const agenda = $('agenda');
    agenda.replaceChildren();
    if (Array.isArray(m.agenda) && m.agenda.length)
      agenda.append(el('strong', '', '주요 안건'), document.createTextNode(m.agenda.join('  \xB7  ')));
    renderSegments();
    renderDraft();
  }
  function renderSegments() {
    const meeting = state.selected;
    if (!meeting)
      return;
    const query = $('speech-search').value.trim().toLocaleLowerCase('ko');
    const items = editedMeeting(meeting).segments.filter(s => [
      s.speaker,
      s.text
    ].some(v => textMatches(v, query)));
    $('segment-count').textContent = `${ items.length }건`;
    const container = $('segments');
    container.replaceChildren();
    $('speech-empty').hidden = items.length > 0;
    $('speech-empty').textContent = query ? '검색 결과가 없습니다. 다른 검색어를 입력해 보세요.' : '표시할 발언이 없습니다.';
    items.forEach(segment => {
      const card = el('article', 'segment');
      card.dataset.cueId = String(segment.id);
      const top = el('div', 'segment-top');
      const url = playbackUrl(segment, meeting);
      const time = el(url ? 'a' : 'span', 'timestamp', timestamp(segment.start));
      if (url) {
        time.href = url;
        time.target = '_blank';
        time.rel = 'noopener noreferrer';
        time.setAttribute('aria-label', `${ timestamp(segment.start) } 원문에서 열기`);
      }
      top.append(time, el('span', 'speaker', segment.speaker || '발언자 미상'), el('span', 'segment-status', segment.status || '검토용 발췌'));
      const edit = el('button', 'edit-btn', '수정');
      edit.type = 'button';
      edit.setAttribute('aria-label', `${ segment.speaker || '발언' } 내용 수정`);
      top.append(edit);
      const text = el('p', 'segment-text', segment.text || '내용 없음');
      card.append(top, text);
      edit.addEventListener('click', () => {
        edit.hidden = true;
        text.hidden = true;
        const form = el('form', 'edit-form');
        const speakerLabel = el('label', '', '발언자');
        const speakerInput = el('input');
        speakerInput.value = segment.speaker || '';
        speakerLabel.append(speakerInput);
        const textLabel = el('label', '', '발언 내용');
        const textInput = el('textarea');
        textInput.value = segment.text || '';
        textLabel.append(textInput);
        const actions = el('div', 'edit-actions');
        const cancel = el('button', 'button', '취소');
        cancel.type = 'button';
        const save = el('button', 'button primary', '저장');
        save.type = 'submit';
        actions.append(cancel, save);
        form.append(speakerLabel, textLabel, actions);
        card.append(form);
        cancel.addEventListener('click', () => {
          form.remove();
          text.hidden = false;
          edit.hidden = false;
          edit.focus();
        });
        form.addEventListener('submit', event => {
          event.preventDefault();
          const key = String(meeting._workspaceKey || meeting.id);
          state.edits[key] ||= {};
          state.edits[key][String(segment.id)] = {
            speaker: speakerInput.value,
            text: textInput.value
          };
          try {
            localStorage.setItem(storageKey, JSON.stringify(state.edits));
            toast('수정 내용을 이 브라우저에 저장했습니다.');
          } catch {
            toast('브라우저 저장에 실패했습니다. 현재 화면에서만 유지됩니다.');
          }
          renderSegments();
          renderDraft();
        });
        speakerInput.focus();
      });
      container.append(card);
    });
  }
  function renderDraft() {
    const items = state.selected?.draft?.items;
    const section = $('draft-section'), container = $('draft-items');
    container.replaceChildren();
    section.hidden = !Array.isArray(items) || !items.length;
    const hasEdits = Object.keys(state.edits[String(state.selected?._workspaceKey || state.selected?.id)] || {}).length > 0;
    section.querySelector('p').textContent = hasEdits ? '발언이 수정되어 요약과 다를 수 있습니다. 연결된 발언과 공식 원문을 다시 확인하세요.' : '제공된 초안입니다. 연결된 발언과 공식 원문을 확인하세요.';
    if (section.hidden)
      return;
    items.forEach(item => {
      if (!item || typeof item.text !== 'string')
        return;
      const row = el('div', 'draft-item');
      if (item.kind)
        row.append(el('strong', '', String(item.kind)));
      row.append(document.createTextNode(item.text));
      (Array.isArray(item.cueIds) ? item.cueIds : []).forEach(id => {
        if (!(state.selected.segments || []).some(s => String(s.id) === String(id)))
          return;
        const button = el('button', 'draft-cue', '연결 발언 보기');
        button.type = 'button';
        button.addEventListener('click', () => {
          $('speech-search').value = '';
          renderSegments();
          const card = [...$('segments').children].find(node => node.dataset.cueId === String(id));
          if (card) {
            card.classList.add('highlight');
            card.scrollIntoView({
              behavior: 'smooth',
              block: 'center'
            });
            setTimeout(() => card.classList.remove('highlight'), 3500);
          }
        });
        row.append(button);
      });
      container.append(row);
    });
  }
  function validMeeting(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m) || m.id == null || typeof m.title !== 'string' || !Array.isArray(m.segments))
      return false;
    const validUrl = value => !value || typeof value === 'string' && !!safeUrl(value) && /^https?:/i.test(value);
    if (!validUrl(m.sourceUrl) || !validUrl(m.minutesUrl) || m.agenda != null && (!Array.isArray(m.agenda) || m.agenda.some(a => typeof a !== 'string')))
      return false;
    const ids = new Set();
    const validSegments = m.segments.every(s => {
      if (!s || !['string', 'number'].includes(typeof s.id) || ['__proto__', 'constructor', 'prototype'].includes(String(s.id)) || ids.has(String(s.id)) || !validUrl(s.sourceUrl) || typeof s.text !== 'string' || s.speaker != null && typeof s.speaker !== 'string')
        return false;
      ids.add(String(s.id));
      return Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start;
    });
    if (!validSegments || m.draft == null) return validSegments;
    return Array.isArray(m.draft.items) && m.draft.items.every(item =>
      item && typeof item.text === 'string' && typeof item.kind === 'string' &&
      Array.isArray(item.cueIds) && item.cueIds.length > 0 &&
      item.cueIds.every(id => ids.has(String(id)))
    );
  }
  $('import-file').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file)
      return;
    try {
      if (file.size > 10 * 1024 * 1024)
        throw new Error('파일 크기는 10MB 이하여야 합니다.');
      const data = JSON.parse(await file.text());
      const meetings = Array.isArray(data) ? data : Array.isArray(data?.meetings) ? data.meetings : [data];
      if (!meetings.length || !meetings.every(validMeeting))
        throw new Error('회의 형식, 시간 또는 원문 주소를 확인해 주세요.');
      const imported = await Promise.all(meetings.map(async meeting => {
        const bytes = new TextEncoder().encode(JSON.stringify(meeting));
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const key = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
        return { ...meeting, _workspaceKey: 'import-' + key };
      }));
      const importedKeys = new Set(imported.map(meeting => meeting._workspaceKey));
      state.meetings = [
        ...imported,
        ...state.meetings.filter(meeting => !importedKeys.has(meeting._workspaceKey))
      ];
      state.selected = imported[0];
      $('meeting-search').value = '';
      $('speech-search').value = '';
      renderList();
      renderDetail();
      toast(`${ imported.length }개 회의를 이 브라우저에서 열었습니다.`);
    } catch (error) {
      toast(error instanceof SyntaxError ? '올바른 JSON 파일을 선택해 주세요.' : error.message || '파일을 불러오지 못했습니다.');
    }
  });
  $('meeting-search').addEventListener('input', renderList);
  $('speech-search').addEventListener('input', renderSegments);
  $('export-toggle').addEventListener('click', () => {
    const open = $('export-menu').hidden;
    $('export-menu').hidden = !open;
    $('export-toggle').setAttribute('aria-expanded', String(open));
  });
  $('export-menu').addEventListener('click', async event => {
    const button = event.target.closest('button[data-export]');
    if (!button || !state.selected)
      return;
    $('export-menu').hidden = true;
    $('export-toggle').setAttribute('aria-expanded', 'false');
    const kind = button.dataset.export;
    try {
      if (!window.CouncilExports || typeof window.CouncilExports[kind] !== 'function')
        throw new Error('내보내기 기능을 불러오지 못했습니다.');
      const output = await window.CouncilExports[kind](editedMeeting(state.selected));
      const ext = kind === 'minutesHwpx' ? 'hwpx' : kind === 'vtt' ? 'vtt' : 'txt';
      const blob = output instanceof Blob ? output : new Blob([output], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${ String(state.selected.title || '회의록').replace(/[\\/:*?"<>|]/g, '_') }.${ ext }`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('검토한 회의자료를 내려받았습니다.');
    } catch (error) {
      toast(error.message || '내보내기에 실패했습니다.');
    }
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.export-wrap')) {
      $('export-menu').hidden = true;
      $('export-toggle').setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      event.preventDefault();
      $('meeting-search').focus();
    }
    if (event.key === 'Escape') {
      $('export-menu').hidden = true;
      $('export-toggle').setAttribute('aria-expanded', 'false');
    }
  });
  fetch('./data/meetings.json').then(response => {
    if (!response.ok)
      throw new Error('회의자료를 불러오지 못했습니다.');
    return response.json();
  }).then(data => {
    const meetings = Array.isArray(data) ? data : data?.meetings;
    if (!Array.isArray(meetings))
      throw new Error('회의자료 형식을 확인해 주세요.');
    state.meetings = meetings;
    state.selected = meetings[0] || null;
    renderList();
    renderDetail();
  }).catch(error => {
    $('meeting-list').replaceChildren(el('div', 'empty-results', error.message || '회의자료를 불러오지 못했습니다.'));
    $('detail-empty').querySelector('h2').textContent = '회의자료를 불러올 수 없습니다';
    $('detail-empty').querySelector('p').textContent = '잠시 후 다시 확인해 주세요.';
  });
})();
