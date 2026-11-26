// One schedule per Korean calendar day. The dated fallback may only serve its own day.
export function seoulDay(timestamp) {
  return new Date(Number(timestamp) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function readScheduleMirror(date, fetcher = fetch) {
  const url = 'https://raw.githubusercontent.com/GnuDaSsa/seongnam-council-captions/caption-quality-log/schedule/latest.json';
  const response = await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(4000)});
  if (!response.ok) return null;
  const catalog = await response.json();
  const official = 'https://cast.sncouncil.go.kr';
  if (catalog?.date !== date || !catalog.schedule?.startsWith(official+'/schedule/live_schedule.jsp?') ||
      !Array.isArray(catalog.meetings) || catalog.meetings.length > 40 ||
      !catalog.meetings.every(m => typeof m.id === 'string' && typeof m.title === 'string' &&
        m.scheduledAt?.startsWith(date+'T') && m.officialPage?.startsWith(official+'/') &&
        (!m.playlist || /^https:\/\/cast\.sncouncil\.go\.kr:4443\/live\/[\w.-]+\/playlist\.m3u8$/.test(m.playlist)) &&
        (!m.externalBroadcastUrl || m.externalBroadcastUrl === 'https://www.youtube.com/@sncouncil'))) return null;
  return catalog;
}

export function createDailyCatalog({load, mirror, seed, datedSeeds = [], clock = Date.now}) {
  const dates = [seed, ...datedSeeds];
  let current, pending;
  const cacheKey = date => 'council-schedules/day/' + date;
  const officialId = id => /^[1-9]\d{0,11}$/.test(id);
  async function read(bucket, key) {
    try {
      const obj = await bucket?.get(key);
      return obj ? await obj.json() : null;
    } catch { return null; }
  }
  function valid(catalog, date) {
    return catalog?.date === date && Array.isArray(catalog.meetings);
  }
  async function save(bucket, catalog, prior, checkedAt) {
    if (!bucket?.put) return;
    const envelope = {catalog, checkedAt};
    const changed = JSON.stringify(catalog) !== JSON.stringify(prior?.catalog);
    // Store the ID indexes before publishing the new day snapshot.
    if (changed) await Promise.all(catalog.meetings.filter(m => officialId(m.id)).map(
      m => bucket.put('council-schedules/id/' + m.id, JSON.stringify(catalog.date))));
    if (changed && catalog.meetings.some(m => officialId(m.id))) {
      await bucket.put('council-schedules/last', JSON.stringify(catalog));
    }
    await bucket.put(cacheKey(catalog.date), JSON.stringify(envelope));
  }
  async function refresh(bucket, date, now) {
    const previous = await read(bucket, cacheKey(date));
    if (valid(previous?.catalog, date) && now >= previous.checkedAt && now - previous.checkedAt < 120000) {
      return {catalog:previous.catalog, until:previous.checkedAt + 120000};
    }
    const fallback = valid(previous?.catalog, date) ? previous.catalog : dates.find(c => valid(c, date));
    const last = await read(bucket, 'council-schedules/last');
    const recent = [fallback,last,...dates].filter(c => c && c.date <= date && c.meetings?.some(m => officialId(m.id)))
      .sort((a,b) => b.date.localeCompare(a.date))[0];
    // Keep source rosters by committee, independently of recent ID discovery.
    const byId = new Map([...seed.meetings,...(recent?.meetings || [])].map(m => [m.id,m]));
    try {
      const catalog = await load(date, [...byId.values()], new Date(now));
      if (!valid(catalog,date)) throw Error('Invalid official calendar');
      try { await save(bucket,catalog,previous,now); } catch { /* Source data is still usable. */ }
      return {catalog, until:now + 120000};
    } catch (err) {
      let copy;
      try { copy = await mirror?.(date); } catch { /* Mirrors may be unreachable with the council. */ }
      if (valid(copy,date)) {
        const catalog={...copy,cached:true};
        try { await save(bucket,catalog,previous,now); } catch {}
        return {catalog,until:now+120000};
      }
      if (!fallback) throw err;
      return {catalog:{...fallback, cached:true}, until:now + 30000};
    }
  }
  async function today(bucket) {
    const now = clock(), date = seoulDay(now);
    if (current?.catalog.date === date && current.until > now) return current.catalog;
    if (pending?.date === date) return pending.promise;
    const promise = refresh(bucket,date,now).then(result => {
      if (seoulDay(clock()) === date) current = result;
      return result.catalog;
    }).finally(() => { if (pending?.promise === promise) pending = null; });
    pending = {date,promise};
    return promise;
  }
  async function forId(bucket,id) {
    if (!officialId(id)) return null;
    const day = seoulDay(clock());
    if (current?.catalog.date === day && current.until > clock() && current.catalog.meetings.some(m=>m.id===id)) return current.catalog;
    const priorDay = await read(bucket,'council-schedules/id/' + id);
    if (typeof priorDay === 'string' && priorDay < day && /^\d{4}-\d{2}-\d{2}$/.test(priorDay)) {
      const prior = await read(bucket,cacheKey(priorDay));
      if (valid(prior?.catalog,priorDay) && prior.catalog.meetings.some(m=>m.id===id)) return prior.catalog;
    }
    const bundled = dates.find(c=>c.date<day && c.meetings.some(m=>m.id===id));
    if (bundled) return bundled;
    const catalog = await today(bucket);
    return catalog.meetings.some(m=>m.id===id) ? catalog : null;
  }
  return {today,forId};
}
