import { describe, expect, it } from 'vitest';
import type { StudioEngine } from './engine-port';
import type { MediaItem, MediaLibrary } from './media';
import { PlayerView, type PlayerHost } from './player-view';
import { s } from './ui';
import './strings';

/**
 * A clip the browser refuses to decode has to be reachable where the message about it is.
 *
 * The message for an unsupported codec ends with «press Convert», but the button only appears in
 * the player's empty state for the clip that failed — and that state is only built for a clip
 * that made it into the playlist (`load`). The launcher used to return before adding it, so the
 * user was told to press a button that stayed hidden; this pins the state that fixes it.
 *
 * The engine and the library are stubs on purpose: nothing here plays or decodes anything, the
 * question is only which DOM the view builds for a refused clip.
 */
const refused = (over: Partial<MediaItem> = {}): MediaItem => ({
  id: 'm1',
  name: 'training_files_v2_intro_tutorial.mp4',
  path: '/home/user/Videos/training_files_v2_intro_tutorial.mp4',
  type: 'video',
  status: 'error',
  error: 'The codec inside this .mp4 file (108 KB) is not supported by this browser. Press “Convert”.',
  url: '',
  duration: 0,
  width: 0,
  height: 0,
  hasAudio: false,
  size: 110651,
  thumbs: [],
  image: null,
  peaks: null,
  bytes: null,
  convertible: true,
  ...over,
});

function setup(item: MediaItem): { player: PlayerView; converted: MediaItem[]; projects: number } {
  const items = new Map<string, MediaItem>([[item.id, item]]);
  const state = { converted: [] as MediaItem[], projects: 0 };
  const engine = {
    canvas: document.createElement('canvas'),
    time: 0,
    duration: 0,
    playing: false,
    onTick: () => () => {},
    onState: () => () => {},
    setRate: () => {},
    setVolume: () => {},
    setMuted: () => {},
    setLoop: () => {},
    setStopAt: () => {},
    seek: () => {},
    pause: () => {},
    play: async () => {},
  } as unknown as StudioEngine;
  const library = {
    get: (id: string) => items.get(id),
    onChange: () => () => {},
  } as unknown as MediaLibrary;
  const host: PlayerHost = {
    engine,
    library,
    showProject: () => { state.projects += 1; },
    addClips: () => {},
    openInEditor: () => {},
    saveSelection: () => {},
    toggleFullscreen: () => {},
    status: () => {},
    convert: (media) => { state.converted.push(media); },
    narrow: () => false,
    openSheet: () => {},
    closeSheet: () => {},
  };
  const player = new PlayerView(host);
  player.activate();
  return {
    player,
    converted: state.converted,
    get projects() { return state.projects; },
  } as { player: PlayerView; converted: MediaItem[]; projects: number };
}

const emptyState = (player: PlayerView): HTMLElement => player.root.querySelector('.fvs-player-empty') as HTMLElement;
const convertButton = (player: PlayerView): HTMLButtonElement | undefined =>
  [...emptyState(player).querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(s('convert')));

describe('PlayerView: a clip the browser refused', () => {
  it('shows it with the plain reason and the convert button the message asks for', () => {
    const item = refused();
    const { player } = setup(item);
    player.showRefused(item.id);

    expect(player.items.map((i) => i.mediaId)).toEqual([item.id]);
    const empty = emptyState(player);
    expect(empty.hidden).toBe(false);
    expect(empty.querySelector('.fvs-empty-title')?.textContent).toBe(item.name);
    expect(empty.querySelector('.fvs-empty-hint')?.textContent).toBe(item.error);
    expect(convertButton(player)?.hidden).toBe(false);
  });

  it('keeps the button hidden when the codec is one this app cannot convert', () => {
    const item = refused({ convertible: false, error: 'This file could not be read.' });
    const { player } = setup(item);
    player.showRefused(item.id);

    expect(emptyState(player).hidden).toBe(false);
    expect(emptyState(player).querySelector('.fvs-empty-hint')?.textContent).toBe(item.error);
    expect(convertButton(player)?.hidden).toBe(true);
  });

  it('opens the same convert flow the editor media row opens', () => {
    const item = refused();
    const { player, converted } = setup(item);
    player.showRefused(item.id);
    convertButton(player)?.click();

    expect(converted).toEqual([item]);
  });

  it('selects the clip instead of adding it twice when it is already in the playlist', () => {
    const item = refused();
    const { player } = setup(item);
    player.showRefused(item.id);
    player.showRefused(item.id);

    expect(player.items).toHaveLength(1);
  });
});
