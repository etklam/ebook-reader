import { useCallback, useEffect, useRef, useState } from 'react';
import { speechChunks } from './speech-chunks.ts';
import { t } from '../i18n/translate.ts';

type SpeechInput = { chapterId: string | null; text: string; contentVersion?: string; hasNextChapter: boolean; onNextChapter(): void; getParagraphIndex?(): number; onParagraph?(index: number | null): void };

/** The reader owns this hook so closing a sheet or loading the next chapter cannot stop playback. */
export function useSpeechReader(input: SpeechInput) {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const [rate, setRate] = useState(1);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceUri, setVoiceUri] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [autoNext, setAutoNext] = useState(false);
  const autoNextRef = useRef(false);
  autoNextRef.current = autoNext;
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const [sleepUntil, setSleepUntil] = useState<number | null>(null);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  const [error, setError] = useState('');
  const [currentParagraph, setCurrentParagraph] = useState<number | null>(null);
  const [resumeParagraph, setResumeParagraph] = useState<number | null>(null);
  const paragraphRef = useRef<number | null>(null);
  const setParagraph = (index: number | null) => {
    paragraphRef.current = index; setCurrentParagraph(index); current.current.onParagraph?.(index);
  };
  const version = useRef(0);
  const autoStart = useRef(false);
  const current = useRef(input);
  current.current = input;
  const speakRef = useRef<() => void>(() => undefined);
  const previousContent = useRef<{ chapterId: string | null; text: string; contentVersion?: string } | null>(null);

  const stop = useCallback(() => {
    autoStart.current = false;
    version.current++;
    if (supported) window.speechSynthesis.cancel();
    if (paragraphRef.current !== null) setResumeParagraph(paragraphRef.current);
    setParagraph(null);
    setSpeaking(false); setPaused(false);
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    const refresh = () => setVoices(window.speechSynthesis.getVoices());
    refresh();
    window.speechSynthesis.addEventListener('voiceschanged', refresh);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refresh);
  }, [supported]);

  const start = useCallback((startParagraph = 0) => {
    const chunks = speechChunks(current.current.text, startParagraph);
    if (!supported || !chunks.length) return;
    const token = ++version.current;
    window.speechSynthesis.cancel();
    setError(''); setSpeaking(true); setPaused(false);
    // Short utterances avoid native speech engines truncating entire long chapters.
    const voice = voices.find((item) => item.voiceURI === voiceUri) ?? voices.find((item) => /^zh/i.test(item.lang));
    const play = (index: number) => {
      if (token !== version.current) return;
      if (index >= chunks.length) {
        setSpeaking(false); setPaused(false); setResumeParagraph(null); setParagraph(null);
        if (autoNextRef.current && current.current.hasNextChapter) {
          autoStart.current = true;
          current.current.onNextChapter();
        }
        return;
      }
      const utterance = new SpeechSynthesisUtterance(chunks[index].text);
      utterance.onstart = () => { if (token === version.current) { setParagraph(chunks[index].paragraphIndex); setResumeParagraph(chunks[index].paragraphIndex); } };
      utterance.rate = rate;
      utterance.lang = voice?.lang ?? 'zh-TW';
      if (voice) utterance.voice = voice;
      utterance.onend = () => play(index + 1);
      utterance.onerror = (event) => {
        if (token !== version.current || event.error === 'canceled' || event.error === 'interrupted') return;
        setSpeaking(false); setPaused(false); setParagraph(null);
        setError(t('系統語音播放中斷，可按「朗讀」重新開始。背景播放由瀏覽器與裝置控制。'));
      };
      window.speechSynthesis.speak(utterance);
    };
    play(0);
  }, [rate, supported, voices, voiceUri]);
  const speak = useCallback(() => start(0), [start]);
  speakRef.current = speak;

  useEffect(() => {
    // Empty text is the conversion/loading interval between chapters; retain the pending continuation.
    if (!supported) return;
    const previous = previousContent.current;
    if (previous?.chapterId === input.chapterId && previous.text === input.text && previous.contentVersion === input.contentVersion) return;
    // Loading text may be empty; cancel old playback immediately, retaining only an automatic chapter handoff.
    const continueAutomatically = autoStart.current && previous?.chapterId !== input.chapterId;
    if (input.text) previousContent.current = { chapterId: input.chapterId, text: input.text, contentVersion: input.contentVersion };
    setResumeParagraph(null); setParagraph(null);
    version.current++;
    window.speechSynthesis.cancel();
    setSpeaking(false); setPaused(false);
    if (autoStart.current && input.text && continueAutomatically) {
      autoStart.current = false;
      speakRef.current();
    } else if (input.text) autoStart.current = false;
  }, [input.chapterId, input.text, input.contentVersion, supported]);

  useEffect(() => {
    if (!sleepUntil) { setSleepRemaining(0); return; }
    const update = () => {
      const left = Math.max(0, Math.ceil((sleepUntil - Date.now()) / 1000));
      setSleepRemaining(left);
      if (!left) { setSleepMinutes(0); setSleepUntil(null); stop(); }
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [sleepUntil, stop]);
  useEffect(() => () => { version.current++; if (supported) window.speechSynthesis.cancel(); }, [supported]);

  return {
    supported, rate, setRate, voices, voiceUri, setVoiceUri, speaking, paused,
    autoNext, setAutoNext, sleepMinutes, sleepRemaining, error, speak, stop, currentParagraph, resumeParagraph,
    speakCurrent: () => start(current.current.getParagraphIndex?.() ?? 0),
    speakResume: () => start(resumeParagraph ?? 0),
    togglePause: () => {
      if (paused) window.speechSynthesis.resume(); else window.speechSynthesis.pause();
      setPaused(!paused);
    },
    setSleep: (minutes: number) => {
      setSleepMinutes(minutes); setSleepUntil(minutes ? Date.now() + minutes * 60_000 : null);
    },
  };
}

export function SpeechControls({ controller }: { controller: ReturnType<typeof useSpeechReader> }) {
  const speech = controller;
  if (!speech.supported) return <p className="hint">{t('這個瀏覽器不支援系統語音朗讀。')}</p>;
  return <section className="speech-controls" aria-label={t('語音朗讀控制')}>
    <h3>{t('語音朗讀')}</h3>
    <div className="row-actions">
      {!speech.speaking ? <>
        <button className="btn" onClick={speech.speak}>{t('朗讀本章')}</button>
        <button className="btn" onClick={speech.speakCurrent}>{t('從目前段落朗讀')}</button>
        {speech.resumeParagraph !== null && <button className="btn" onClick={speech.speakResume}>{t('從第 {n} 段續播', { n: speech.resumeParagraph + 1 })}</button>}
      </> : <>
        <button className="btn" onClick={speech.togglePause}>{speech.paused ? t('繼續') : t('暫停')}</button>
        <button className="btn" onClick={speech.stop}>{t('停止')}</button>
      </>}
    </div>
    {speech.currentParagraph !== null && <p className="hint" role="status">
      {t('正在朗讀第 {n} 段', { n: speech.currentParagraph + 1 })}{speech.paused ? t('（已暫停）') : ''}
    </p>}
    <div className="field"><label htmlFor="speech-voice">{t('系統語音')}</label>
      <select className="input" id="speech-voice" value={speech.voiceUri} disabled={speech.speaking}
        onChange={(event) => speech.setVoiceUri(event.target.value)}>
        <option value="">{t('自動選擇中文語音')}</option>
        {speech.voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name}（{voice.lang}）</option>)}
      </select>
    </div>
    <div className="field"><label htmlFor="speech-rate">{t('速度')}</label>
      <select className="input" id="speech-rate" value={speech.rate} disabled={speech.speaking}
        onChange={(event) => speech.setRate(Number(event.target.value))}>
        {[0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
      </select>
    </div>
    <div className="field"><label htmlFor="speech-sleep">{t('睡眠定時')}</label>
      <select className="input" id="speech-sleep" value={speech.sleepMinutes} onChange={(event) => speech.setSleep(Number(event.target.value))}>
        <option value={0}>{t('關閉')}</option>
        {[15, 30, 60].map((minutes) => <option key={minutes} value={minutes}>{t('{n} 分鐘', { n: minutes })}</option>)}
      </select>
    </div>
    <label className="check-line"><input type="checkbox" checked={speech.autoNext}
      onChange={(event) => speech.setAutoNext(event.target.checked)} />{t('讀完自動下一章')}</label>
    {speech.sleepRemaining > 0 && <p className="hint">{t('{n} 分鐘後停止', { n: Math.ceil(speech.sleepRemaining / 60) })}</p>}
    <p className="hint">{t('關閉設定仍會繼續朗讀。背景播放依瀏覽器及裝置支援；語音與速度在開始朗讀前設定。')}</p>
    {speech.error && <p className="form-error" role="alert">{speech.error}</p>}
  </section>;
}
