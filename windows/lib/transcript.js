'use strict';

const SPEAKERS = { interviewer: 'Интервьюер', me: 'Я', unknown: 'Речь' };

function words(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu)) || [];
}

/**
 * Без наушников микрофон слышит собеседника из динамиков, и его слова приписывались бы вам.
 * Фраза микрофона считается эхом, если в то же время почти те же слова звучали в системной дорожке.
 */
function removeEcho(mic, system) {
  return mic.filter((segment) => {
    const micWords = words(segment.text);
    if (micWords.length < 2) return true;

    const systemWords = new Set();
    for (const other of system) {
      if (other.start <= segment.end + 1 && other.end >= segment.start - 1) {
        words(other.text).forEach((word) => systemWords.add(word));
      }
    }
    if (systemWords.size === 0) return true;

    const matches = micWords.filter((word) => systemWords.has(word)).length;
    return matches / micWords.length < 0.7;
  });
}

/** Собирает распознанные фразы двух дорожек в один диалог. */
function buildDialogue(mic, system) {
  const ordered = [...removeEcho(mic, system), ...system].sort((a, b) => a.start - b.start);
  const turns = [];
  for (const segment of ordered) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === segment.speaker) {
      last.end = Math.max(last.end, segment.end);
      last.text = `${last.text} ${segment.text}`;
    } else {
      turns.push({ ...segment });
    }
  }
  return turns;
}

function timestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

function markdown(turns, title) {
  const lines = ['# Расшифровка собеседования', '', title, ''];
  if (turns.length === 0) lines.push('Речь не распознана.');
  for (const turn of turns) {
    lines.push(`**[${timestamp(turn.start)}] ${SPEAKERS[turn.speaker]}:** ${turn.text}`, '');
  }
  return lines.join('\n');
}

function json(turns) {
  return JSON.stringify(
    turns.map((turn) => ({ ...turn, speaker: SPEAKERS[turn.speaker] })),
    null,
    2
  );
}

module.exports = { buildDialogue, removeEcho, markdown, json, timestamp, SPEAKERS };
