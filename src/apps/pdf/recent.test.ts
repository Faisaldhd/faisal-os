import { beforeEach, describe, expect, it } from 'vitest';
import {
  addRecent, checkSaveAsPath, freePdfPath, loadRecent, parseRecent, RECENT_KEY, RECENT_MAX, removeRecent,
  setThumb, storeRecent,
} from './recent';

const entry = (path: string, time = 1) => ({ path, name: path.split('/').pop() ?? '', time });

describe('recent PDFs', () => {
  beforeEach(() => localStorage.clear());

  it('parses defensively: corrupt JSON, outside paths and bad thumbnails are dropped', () => {
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent('{}')).toEqual([]);
    const list = parseRecent(JSON.stringify([
      entry('/home/user/a.pdf', 2),
      entry('/etc/passwd', 3),
      { ...entry('/home/user/b.pdf', 5), thumb: 'javascript:alert(1)' },
      entry('/home/user/a.pdf', 1),
    ]));
    expect(list.map((e) => e.path)).toEqual(['/home/user/b.pdf', '/home/user/a.pdf']);
    expect(list[0].thumb).toBeUndefined();
  });

  it('puts the latest first, keeps a thumbnail, caps the list', () => {
    let list = addRecent([], { ...entry('/home/user/a.pdf'), thumb: 'data:image/jpeg;base64,AAAA' });
    list = addRecent(list, entry('/home/user/b.pdf', 2));
    list = addRecent(list, entry('/home/user/a.pdf', 3));
    expect(list[0].path).toBe('/home/user/a.pdf');
    expect(list[0].thumb).toBe('data:image/jpeg;base64,AAAA');
    for (let i = 0; i < 20; i++) list = addRecent(list, entry(`/home/user/${i}.pdf`, 10 + i));
    expect(list).toHaveLength(RECENT_MAX);
    expect(removeRecent(list, list[0].path)).toHaveLength(RECENT_MAX - 1);
    expect(setThumb(list, list[0].path, 'data:image/jpeg;base64,BB')[0].thumb).toBe('data:image/jpeg;base64,BB');
    expect(setThumb(list, list[0].path, 'data:text/html,x')[0].thumb).toBeUndefined();
  });

  it('stores and loads through localStorage', () => {
    storeRecent([entry('/home/user/x.pdf')]);
    expect(localStorage.getItem(RECENT_KEY)).toContain('x.pdf');
    expect(loadRecent()[0].path).toBe('/home/user/x.pdf');
  });

  it('finds a free name for a new document', async () => {
    const taken = new Set(['/home/user/Documents/Scan.pdf', '/home/user/Documents/Scan-2.pdf']);
    expect(await freePdfPath('/home/user/Documents/', 'Scan.pdf', (p) => taken.has(p))).toBe('/home/user/Documents/Scan-3.pdf');
    expect(await freePdfPath('/home/user', 'a/b:c', () => false)).toBe('/home/user/a b c.pdf');
  });

  it('accepts a save-as path only inside /home/user', () => {
    expect(checkSaveAsPath('/home/user/Docs/out')).toBe('/home/user/Docs/out.pdf');
    expect(checkSaveAsPath('/home/user//a.PDF')).toBe('/home/user/a.PDF');
    expect(checkSaveAsPath('/home/user/../etc/x.pdf')).toBeNull();
    expect(checkSaveAsPath('relative.pdf')).toBeNull();
    expect(checkSaveAsPath('/tmp/x.pdf')).toBeNull();
  });
});
