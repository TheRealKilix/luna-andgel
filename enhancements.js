'use strict';

const sharedState = { tasks: [], albums: [], games: [] };
const sharedKinds = Object.keys(sharedState);
const pushCategories = ['message', 'voice', 'affection', 'reaction', 'date', 'game'];
const defaultNotificationPrefs = Object.fromEntries(pushCategories.map(category => [category, true]));
let replyDraft = null;
let locationWatch = null;
let ownLocation = null;
let peerLocation = null;
let peerLocationAt = 0;
let pushListenersInstalled = false;

function notificationPrefs() {
  try {
    return { ...defaultNotificationPrefs, ...JSON.parse(L.getItem('notification-prefs') || '{}') };
  } catch {
    return { ...defaultNotificationPrefs };
  }
}

function notificationCategory(message) {
  if (message.k === 'h') return 'affection';
  if (message.k === 'r') return 'reaction';
  if (message.k === 'date') return 'date';
  if (message.k === 'shared' && message.kind === 'games' && message.notify) return 'game';
  if (message.k === 'm') return message.aud ? 'voice' : message.replyTo ? 'reaction' : 'message';
  return '';
}

send = async function (message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast('Le relais est déconnecté. Reste connecté pour envoyer.');
    return false;
  }
  if (!key) {
    toast('La connexion sécurisée avec Luna et Andgel n’est pas encore prête.');
    return false;
  }
  try {
    const clientId = b64(rnd(10));
    if (message.k === 'm') transportMap[clientId] = message.id;
    let payload = JSON.stringify(message);
    payload += ' '.repeat((512 - new Blob([payload]).size % 512) % 512);
    ws.send(JSON.stringify({
      t: 'msg',
      clientId,
      ...(notificationCategory(message) ? { category: notificationCategory(message) } : {}),
      d: await seal(key, E.encode(payload))
    }));
    return true;
  } catch (error) {
    console.error('Envoi du message impossible', error);
    toast('Envoi impossible. Vérifie la connexion et réessaie.');
    return false;
  }
};

const originalHandle = handle;
handle = async function (message) {
  if (message.t === 'bad') {
    pairingRejected = true;
    L.removeItem('pairingCode');
    $('#pairingCode').hidden = false;
    $('#pairingCode').value = '';
    $('#app').hidden = true;
    $('#app').style.display = 'none';
    $('#lock').style.display = 'flex';
    $('#err').textContent = 'Code incorrect. Recopie le code affiché dans la fenêtre du relais.';
    return;
  }
  await originalHandle(message);
  if (message.t === 'peer' && L.pushToken) registerPushToken();
};

const originalConnection = conn;
conn = function () {
  if (pairingRejected) return;
  originalConnection();
  if (!ws) return;
  const socket = ws;
  const onMessage = socket.onmessage;
  socket.onmessage = event => {
    try {
      if (JSON.parse(event.data).t === 'bad') pairingRejected = true;
    } catch {}
    onMessage.call(socket, event);
  };
};

function recordsEqual(a, b) {
  return JSON.stringify(a.slice().sort((x, y) => x.id.localeCompare(y.id))) ===
    JSON.stringify(b.slice().sort((x, y) => x.id.localeCompare(y.id)));
}

function mergeRecords(kind, incoming) {
  if (!sharedKinds.includes(kind) || !Array.isArray(incoming)) return false;
  incoming = incoming.slice(-500).map(record => {
    if (kind !== 'albums' || !Array.isArray(record?.photos)) return record;
    return {
      ...record,
      photos: record.photos.filter(photo =>
        photo && typeof photo.id === 'string' &&
        (photo.deleted || (typeof photo.data === 'string' &&
          photo.data.startsWith('data:image/jpeg;base64,') && photo.data.length <= 500_000)))
        .slice(-30)
    };
  });
  const byId = new Map(sharedState[kind].map(record => [record.id, record]));
  for (const candidate of incoming) {
    if (!candidate || typeof candidate.id !== 'string') continue;
    const existing = byId.get(candidate.id);
    if (kind === 'albums' && existing && !existing.deleted && !candidate.deleted) {
      const photos = new Map((existing.photos || []).map(photo => [photo.id, photo]));
      for (const photo of candidate.photos || []) {
        const old = photos.get(photo.id);
        if (!old || Number(photo.updatedAt) > Number(old.updatedAt)) photos.set(photo.id, photo);
      }
      const merged = Number(candidate.updatedAt) > Number(existing.updatedAt) ? candidate : existing;
      byId.set(candidate.id, {
        ...merged,
        photos: [...photos.values()].sort((a, b) => Number(a.createdAt) - Number(b.createdAt))
      });
      continue;
    }
    if (!existing || Number(candidate.updatedAt) > Number(existing.updatedAt) ||
        (Number(candidate.updatedAt) === Number(existing.updatedAt) &&
          String(candidate.updatedBy) > String(existing.updatedBy))) {
      byId.set(candidate.id, candidate);
    }
  }
  const merged = [...byId.values()].sort((a, b) => Number(a.updatedAt) - Number(b.updatedAt));
  const changed = !recordsEqual(sharedState[kind], merged);
  sharedState[kind] = merged;
  return changed;
}

async function saveShared(kind, broadcast = true, notification = '') {
  const keyName = `shared-${kind}`;
  try {
    L.setItem(keyName, await seal(lk, E.encode(JSON.stringify(sharedState[kind]))));
  } catch (error) {
    console.error(`Sauvegarde locale de ${kind} impossible`, error);
    toast('Stockage local plein. Réduis le nombre de photos partagées.');
  }
  if (broadcast && key && ws?.readyState === WebSocket.OPEN) {
    await send({ k: 'shared', kind, records: sharedState[kind], ...(notification ? { notify: notification } : {}) });
  }
}

async function loadShared() {
  for (const kind of sharedKinds) {
    const saved = L.getItem(`shared-${kind}`);
    if (!saved) continue;
    try {
      const records = JSON.parse(D.decode(await open(lk, saved)));
      mergeRecords(kind, records);
    } catch (error) {
      console.error(`Données locales ${kind} illisibles`, error);
      toast(`Impossible de lire les données locales (${kind}).`);
    }
  }
}

async function syncShared(kind) {
  if (sharedKinds.includes(kind)) await send({ k: 'shared', kind, records: sharedState[kind] });
}

const originalSetPeer = setPeer;
setPeer = async function (publicKey, accept) {
  await originalSetPeer(publicKey, accept);
  await loadShared();
  for (const kind of sharedKinds) await syncShared(kind);
  if (L.coupleDate && !L.coupleDateUpdatedAt) {
    L.coupleDateUpdatedAt = String(Date.now());
    L.coupleDateUpdatedBy = me;
  }
  if (L.coupleDateUpdatedAt) {
    await send({ k: 'date', date: L.coupleDate || '', updatedAt: Number(L.coupleDateUpdatedAt) || 0, updatedBy: L.coupleDateUpdatedBy || me });
  }
  if (ownProfile.note || ownProfile.name || ownProfile.avatar) {
    await send({ k: 'profile', p: ownProfile });
  }
  if (ownLocation) {
    await send({ k: 'location', sharing: true, ...ownLocation, updatedAt: Date.now() });
  }
  if (L.pushToken) registerPushToken();
};

const originalReceive = recv;
recv = async function (message) {
  if (message.k === 'shared') {
    if (!sharedKinds.includes(message.kind)) return;
    const changed = mergeRecords(message.kind, message.records);
    if (changed) {
      await saveShared(message.kind, false);
      if (message.kind === 'tasks' && featureState.type === 'tasks') renderFeature();
      if (message.kind === 'albums' && featureState.type === 'albums') renderFeature();
      if (message.kind === 'games' && ['games', 'truth'].includes(featureState.type)) renderFeature();
      await syncShared(message.kind);
      if (message.kind === 'games' && message.notify) notifyIfPushUnavailable('Invitation à jouer', 'Une invitation à jouer t’attend.', 'game');
    }
    return;
  }
  if (message.k === 'date') {
    const timestamp = Number(message.updatedAt) || 0;
    const incomingBy = String(message.updatedBy || other);
    if (timestamp > (Number(L.coupleDateUpdatedAt) || 0) ||
        (timestamp === (Number(L.coupleDateUpdatedAt) || 0) && incomingBy > String(L.coupleDateUpdatedBy || ''))) {
      L.coupleDate = typeof message.date === 'string' ? message.date : '';
      L.coupleDateUpdatedAt = String(timestamp);
      L.coupleDateUpdatedBy = incomingBy;
      applyProfileUI();
      if ($('#dateModal').classList.contains('open')) {
        $('#coupleDate').value = L.coupleDate;
        $('#dateHelp').textContent = L.coupleDate ? countdown(L.coupleDate) : 'Aucune date partagée.';
      }
    }
    notifyIfPushUnavailable('Luna & Andgel', 'Une date importante a changé', 'date');
    return;
  }
  if (message.k === 'location') {
    const timestamp = Number(message.updatedAt) || 0;
    if (timestamp >= peerLocationAt) {
      peerLocationAt = timestamp;
      peerLocation = message.sharing && Number.isFinite(message.lat) && Number.isFinite(message.lon)
        ? { lat: message.lat, lon: message.lon, updatedAt: timestamp }
        : null;
      updateDistanceLabel();
      if (featureState.type === 'distance') renderFeature();
    }
    return;
  }
  if (message.k === 'profile') {
    peerProfile = {
      ...peerProfile,
      name: String(message.p?.name || '').slice(0, 32),
      avatar: typeof message.p?.avatar === 'string' ? message.p.avatar : '',
      note: String(message.p?.note || '').slice(0, 500)
    };
    L[`profile_${other}`] = JSON.stringify(peerProfile);
    applyProfileUI();
    return;
  }
  await originalReceive(message);
  if (message.k === 'm') {
    vibe(60);
    notifyIfPushUnavailable('Luna & Andgel', message.aud ? 'Nouveau message vocal' : 'Nouveau message', message.aud ? 'voice' : message.replyTo ? 'reaction' : 'message');
  } else if (message.k === 'h') {
    notifyIfPushUnavailable('Luna & Andgel', 'Un cœur ou un câlin t’attend', 'affection');
  } else if (message.k === 'r') {
    notifyIfPushUnavailable('Luna & Andgel', 'Nouvelle réaction à un message', 'reaction');
  }
};

const originalVibe = vibe;
vibe = function (pattern, showNotice = false) {
  if (!$('#vibrate')?.checked) return false;
  const haptics = plugin('Haptics');
  if (!haptics?.vibrate) return originalVibe(pattern, showNotice);
  const durations = Array.isArray(pattern) ? pattern : [pattern];
  void (async () => {
    for (let index = 0; index < durations.length; index++) {
      const duration = Number(durations[index]);
      if (!Number.isFinite(duration) || duration <= 0) continue;
      if (index % 2) await new Promise(resolve => setTimeout(resolve, Math.min(800, duration)));
      else await haptics.vibrate({ duration: Math.min(800, duration) });
    }
  })().catch(error => {
    console.error('Vibration haptique impossible', error);
    originalVibe(pattern, showNotice);
  });
  return true;
};

function setReply(message) {
  replyDraft = message;
  let preview = $('#replyPreview');
  if (!preview) {
    preview = document.createElement('div');
    preview.id = 'replyPreview';
    preview.innerHTML = '<span></span><button type="button" aria-label="Annuler la réponse">×</button>';
    $('#app').insertBefore(preview, document.querySelector('#app footer'));
    preview.querySelector('button').onclick = () => setReply(null);
  }
  preview.hidden = !message;
  if (message) preview.querySelector('span').textContent =
    `Réponse à ${message.f === me ? 'toi' : peerName()} : ${message.text || (message.aud ? 'Message vocal' : 'Pièce jointe')}`;
}

const originalOutgoing = outgoing;
outgoing = async function (message) {
  const withReply = replyDraft
    ? { ...message, replyTo: { id: replyDraft.id, text: String(replyDraft.text || 'Pièce jointe').slice(0, 160) } }
    : message;
  const result = await originalOutgoing(withReply);
  if (result !== false && ws?.readyState === WebSocket.OPEN && key && replyDraft) setReply(null);
  return result;
};

const originalDraw = draw;
draw = function () {
  originalDraw();
  const bubbles = $('#list').querySelectorAll('.b');
  let index = 0;
  for (const bubble of bubbles) {
    const message = hist[index++];
    if (!message) continue;
    if (message.replyTo && !bubble.querySelector('.replyQuote')) {
      const quote = document.createElement('div');
      quote.className = 'replyQuote';
      quote.textContent = message.replyTo.text;
      bubble.prepend(quote);
    }
    if (bubble.querySelector('.bubbleActions')) continue;
    const actions = document.createElement('div');
    actions.className = 'bubbleActions';
    const react = document.createElement('button');
    react.type = 'button';
    react.textContent = '☺';
    react.setAttribute('aria-label', 'Réagir');
    react.onclick = event => {
      event.stopPropagation();
      let picker = bubble.querySelector('.reactionPicker');
      if (picker) { picker.remove(); return; }
      picker = document.createElement('div');
      picker.className = 'reactionPicker';
      for (const emoji of ['❤️', '😂', '🥹', '🔥', '👍', '😮']) {
        const option = document.createElement('button');
        option.type = 'button';
        option.textContent = emoji;
        option.onclick = async choice => {
          choice.stopPropagation();
          message.r = message.r || {};
          message.r[me] = emoji;
          await send({ k: 'r', id: message.id, e: emoji });
          await save();
          draw();
        };
        picker.append(option);
      }
      actions.append(picker);
    };
    actions.append(react);
    bubble.append(actions);
  }
};

let swipeStart = null;
$('#list').addEventListener('touchstart', event => {
  const bubble = event.target.closest('.b');
  if (bubble && event.touches.length === 1) {
    swipeStart = { bubble, x: event.touches[0].clientX, y: event.touches[0].clientY };
  }
}, { passive: true });
$('#list').addEventListener('touchend', event => {
  if (!swipeStart || !event.changedTouches.length) return;
  const dx = event.changedTouches[0].clientX - swipeStart.x;
  const dy = event.changedTouches[0].clientY - swipeStart.y;
  if (dx < -65 && Math.abs(dy) < 45) {
    const index = [...$('#list').querySelectorAll('.b')].indexOf(swipeStart.bubble);
    if (hist[index]) { setReply(hist[index]); $('#msg').focus(); }
  }
  swipeStart = null;
}, { passive: true });

function saveDate(date) {
  L.coupleDate = date;
  L.coupleDateUpdatedAt = String(Date.now());
  L.coupleDateUpdatedBy = me;
  applyProfileUI();
  void send({ k: 'date', date, updatedAt: Number(L.coupleDateUpdatedAt), updatedBy: me });
}
$('#saveDate').onclick = () => {
  if (!$('#coupleDate').value) { toast('Choisis une date ou utilise le bouton supprimer.'); return; }
  saveDate($('#coupleDate').value);
  $('#dateModal').classList.remove('open');
  toast('Date importante synchronisée 💗');
};
$('#deleteDate').onclick = () => {
  saveDate('');
  $('#coupleDate').value = '';
  $('#dateHelp').textContent = 'Aucune date partagée.';
  toast('Date partagée supprimée.');
};
$('#dateOpen').addEventListener('click', () => {
  $('#coupleDate').value = L.coupleDate || '';
  $('#dateHelp').textContent = L.coupleDate ? countdown(L.coupleDate) : 'Choisissez un jour qui compte.';
});

$('#profileOpen').addEventListener('click', () => {
  $('#profileNote').value = ownProfile.note || '';
});
$('#saveProfile').onclick = async () => {
  ownProfile = {
    ...ownProfile,
    name: $('#myName').value.trim() || (me === 'andgel' ? 'Andgel' : 'Luna'),
    note: $('#profileNote').value.trim().slice(0, 500),
    avatar: avatarDraft
  };
  L[`profile_${me}`] = JSON.stringify(ownProfile);
  const alias = $('#peerAlias').value.trim();
  if (alias) L[`alias_${other}`] = alias;
  else L.removeItem(`alias_${other}`);
  applyProfileUI();
  await send({ k: 'profile', p: ownProfile });
  $('#profileModal').classList.remove('open');
  toast('Profil et note synchronisés.');
};

function updateSharedRecord(kind, record) {
  const current = sharedState[kind].find(item => item.id === record.id);
  const next = {
    ...(current || {}),
    ...record,
    id: record.id || b64(rnd(12)),
    updatedAt: Date.now(),
    updatedBy: me
  };
  const index = sharedState[kind].findIndex(item => item.id === next.id);
  if (index < 0) sharedState[kind].push(next);
  else sharedState[kind][index] = next;
  void saveShared(kind);
}

function renderTasks(panel) {
  const tasks = sharedState.tasks.filter(task => !task.deleted)
    .sort((a, b) => Number(a.done) - Number(b.done) || Number(a.createdAt) - Number(b.createdAt));
  panel.innerHTML = '<p>Vos idées et tâches, organisées ensemble.</p><div class="taskComposer"><input id="taskDraft" maxlength="160" placeholder="Ajouter une tâche, un achat ou une idée"><button class="featureAction" data-action="taskAdd">Ajouter</button></div><div class="sharedList"></div>';
  const list = panel.querySelector('.sharedList');
  if (!tasks.length) { list.textContent = 'Rien pour le moment. Ajoutez votre première tâche.'; return; }
  for (const task of tasks) {
    const row = document.createElement('article');
    row.className = 'sharedRow';
    const check = document.createElement('input');
    check.type = 'checkbox'; check.checked = !!task.done; check.dataset.action = 'taskToggle'; check.dataset.id = task.id;
    const text = document.createElement('span'); text.textContent = task.text;
    text.className = task.done ? 'taskText isDone' : 'taskText';
    const meta = document.createElement('small');
    meta.textContent = `${task.addedBy === me ? 'Ajoutée par toi' : 'Ajoutée par ' + peerName()}${task.done ? ' · terminée par ' + (task.completedBy === me ? 'toi' : peerName()) : ''}`;
    const details = document.createElement('div'); details.className = 'taskDetails'; details.append(text, meta);
    const actions = document.createElement('div'); actions.className = 'taskActions';
    const edit = document.createElement('button'); edit.textContent = 'Modifier'; edit.dataset.action = 'taskEdit'; edit.dataset.id = task.id;
    const remove = document.createElement('button'); remove.textContent = 'Supprimer'; remove.dataset.action = 'taskDelete'; remove.dataset.id = task.id;
    actions.append(edit, remove); row.append(check, details, actions); list.append(row);
  }
}

function renderAlbums(panel) {
  const albums = sharedState.albums.filter(album => !album.deleted)
    .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
  panel.innerHTML = '<p>Photos compressées, chiffrées avant envoi et visibles sur vos deux appareils.</p><input id="albumName" maxlength="48" placeholder="Nom du nouvel album"><button class="featureAction" data-action="albumCreate">Créer un album</button><div class="albumList"></div>';
  const list = panel.querySelector('.albumList');
  for (const album of albums) {
    const block = document.createElement('section'); block.className = 'albumBlock';
    const heading = document.createElement('div'); heading.className = 'albumHeading';
    const name = document.createElement('strong'); name.textContent = album.name;
    const rename = document.createElement('button'); rename.textContent = 'Renommer'; rename.dataset.action = 'albumRename'; rename.dataset.id = album.id;
    const remove = document.createElement('button'); remove.textContent = 'Supprimer'; remove.dataset.action = 'albumDelete'; remove.dataset.id = album.id;
    heading.append(name, rename, remove);
    const photos = document.createElement('div'); photos.className = 'albumPhotos';
    for (const photo of album.photos || []) {
      if (photo.deleted || !photo.data) continue;
      const wrapper = document.createElement('div'); wrapper.className = 'albumPhoto';
      const image = new Image(); image.src = photo.data; image.alt = 'Photo de l’album'; image.loading = 'lazy';
      const removePhoto = document.createElement('button'); removePhoto.textContent = '×';
      removePhoto.dataset.action = 'albumPhotoDelete'; removePhoto.dataset.id = album.id; removePhoto.dataset.photo = photo.id;
      wrapper.append(image, removePhoto); photos.append(wrapper);
    }
    const addPhoto = document.createElement('button'); addPhoto.textContent = 'Ajouter des photos'; addPhoto.dataset.action = 'albumAddPhoto'; addPhoto.dataset.id = album.id;
    block.append(heading, photos, addPhoto); list.append(block);
  }
  if (!albums.length) list.textContent = 'Créez un album pour vos souvenirs à deux.';
}

function renderGames(panel) {
  const games = sharedState.games.filter(game => !game.deleted && ['ttt', 'rps'].includes(game.kind));
  const active = games.slice().sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))[0];
  panel.innerHTML = '<p>Choisissez un jeu et invitez l’autre personne.</p><div class="choiceGrid"><button class="choice" data-action="gameInvite" data-kind="ttt">Morpion</button><button class="choice" data-action="gameInvite" data-kind="rps">Pierre, feuille, ciseaux</button><button class="choice" data-action="gameInvite" data-kind="c4">Puissance 4</button></div><div class="gameStage"></div>';
  const stage = panel.querySelector('.gameStage');
  if (!active) return;
  if (active.kind === 'truth') { renderTruthGame(stage, active); return; }
  const heading = document.createElement('h3');
  heading.textContent = active.kind === 'ttt' ? 'Morpion' : active.kind === 'c4' ? 'Puissance 4' : 'Pierre, feuille, ciseaux';
  stage.append(heading);
  if (active.status === 'invited' && active.invitedBy !== me) {
    addGameButton(stage, 'Accepter', 'gameAccept', active.id);
    addGameButton(stage, 'Refuser', 'gameDecline', active.id);
    return;
  }
  if (active.status === 'invited') { stage.append(document.createTextNode('Invitation envoyée — en attente de réponse.')); return; }
  if (active.kind === 'ttt') {
    const board = document.createElement('div'); board.className = 'ticBoard';
    for (let i = 0; i < 9; i++) {
      const cell = document.createElement('button'); cell.className = 'ticCell'; cell.textContent = active.board[i] || '';
      cell.dataset.action = 'ticMove'; cell.dataset.id = active.id; cell.dataset.cell = String(i);
      cell.disabled = active.status !== 'active' || active.turn !== me || !!active.board[i];
      board.append(cell);
    }
    stage.append(board, document.createTextNode(active.winner ? (active.winner === 'draw' ? 'Égalité !' : `${active.winner === me ? 'Tu as gagné' : peerName() + ' a gagné'} !`) : `À ${active.turn === me ? 'toi' : peerName()} de jouer.`));
  } else if (active.kind === 'c4') {
    const board = document.createElement('div'); board.className = 'connectBoard';
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 7; col++) {
        const cell = document.createElement('button');
        cell.className = 'connectCell';
        const mark = active.board[row * 7 + col];
        cell.textContent = mark === 'X' ? '🔴' : mark === 'O' ? '🟡' : '';
        cell.dataset.action = 'connectMove'; cell.dataset.id = active.id; cell.dataset.col = String(col);
        cell.disabled = active.status !== 'active' || active.turn !== me || !!active.board[col];
        board.append(cell);
      }
    }
    stage.append(board, document.createTextNode(active.winner
      ? (active.winner === 'draw' ? 'Égalité !' : `${active.winner === me ? 'Tu as gagné' : peerName() + ' a gagné'} !`)
      : `À ${active.turn === me ? 'toi' : peerName()} de jouer.`));
  } else {
    const choices = document.createElement('div'); choices.className = 'choiceGrid';
    for (const choice of ['Pierre', 'Feuille', 'Ciseaux']) {
      const button = document.createElement('button'); button.className = 'choice'; button.textContent = choice;
      button.dataset.action = 'rpsMove'; button.dataset.id = active.id; button.dataset.value = choice;
      button.disabled = active.status !== 'active' || !!active.choices?.[me];
      choices.append(button);
    }
    stage.append(choices);
    if (active.choices?.andgel && active.choices?.luna) {
      const result = document.createElement('p'); result.textContent = rpsResult(active.choices.andgel, active.choices.luna);
      stage.append(result);
    } else stage.append(document.createTextNode(active.choices?.[me] ? 'Ton choix est enregistré; attends l’autre.' : 'Choisis sans voir celui de l’autre.'));
  }
}

function addGameButton(root, label, action, id) {
  const button = document.createElement('button'); button.className = 'featureAction'; button.textContent = label;
  button.dataset.action = action; button.dataset.id = id; root.append(button);
}
function rpsResult(a, b) {
  if (a === b) return 'Égalité ! Rejouez.';
  const andgelWins = (a === 'Pierre' && b === 'Ciseaux') ||
    (a === 'Feuille' && b === 'Pierre') || (a === 'Ciseaux' && b === 'Feuille');
  return `${andgelWins ? 'Andgel' : 'Luna'} gagne cette manche.`;
}
function gameWinner(board) {
  for (const [a, b, c] of [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  function connectWinner(board) {
    const columns = 7, rows = 6;
    for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
      const mark = board[row * columns + col];
      if (!mark) continue;
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        let count = 1;
        for (let step = 1; step < 4; step++) {
          const nextRow = row + dr * step, nextCol = col + dc * step;
          if (nextRow < 0 || nextRow >= rows || nextCol < 0 || nextCol >= columns ||
              board[nextRow * columns + nextCol] !== mark) break;
          count++;
        }
        if (count === 4) return mark;
      }
    }
    return board.every(Boolean) ? 'draw' : '';
  }
  return board.every(Boolean) ? 'draw' : '';
}

const truthCategories = {
  drôle: ['Quelle est ta pire danse secrète ?', 'Quelle est la chose la plus bizarre que tu aies mangée ?'],
  amoureux: ['Quel petit geste de moi te touche le plus ?', 'Quel souvenir de nous gardes-tu près du cœur ?'],
  complice: ['Quelle aventure aimerais-tu qu’on tente ensemble ?', 'Quelle tradition rien qu’à nous devrait-on créer ?'],
  gênant: ['Quelle chanson connais-tu par cœur mais assumes peu ?', 'Quel a été ton plus gros fou rire au mauvais moment ?'],
  romantique: ['Quel serait ton rendez-vous parfait avec moi ?', 'À quel moment t’es-tu senti·e particulièrement aimé·e ?'],
  spicy: ['Quel compliment un peu audacieux aimerais-tu recevoir ?', 'Quel détail chez moi te fait rougir ?'],
  intime: ['Qu’aimerais-tu que je comprenne mieux de toi ?', 'De quoi as-tu besoin pour te sentir en confiance ?']
};
function renderTruthGame(root, game) {
  const title = document.createElement('h3'); title.textContent = 'Action ou vérité'; root.append(title);
  if (game.status === 'invited' && game.invitedBy !== me) {
    root.append(document.createTextNode('Invitation reçue. Tu peux accepter ou passer.'));
    addGameButton(root, 'Accepter', 'gameAccept', game.id); addGameButton(root, 'Passer', 'gameDecline', game.id); return;
  }
  if (game.status === 'invited') { root.append(document.createTextNode('Invitation envoyée — en attente de réponse.')); return; }
  if (game.status === 'choose') {
    root.append(document.createTextNode('Choisis une catégorie et un type de tour. Chacun peut passer.'));
    for (const category of Object.keys(truthCategories)) {
      for (const mode of ['truth', 'dare']) {
        const button = document.createElement('button'); button.className = 'choice';
        button.textContent = `${category} · ${mode === 'truth' ? 'Vérité' : 'Action'}`;
        button.dataset.action = 'truthCategory'; button.dataset.id = game.id;
        button.dataset.value = category; button.dataset.mode = mode; root.append(button);
      }
    }
    addGameButton(root, 'Fermer la partie', 'gameDecline', game.id); return;
  }
  if (game.status === 'ask') {
    const text = document.createElement('p'); text.className = 'featurePrompt'; text.textContent = `${game.mode === 'truth' ? 'Vérité' : 'Action'} · ${game.category} : ${game.prompt}`; root.append(text);
    if (game.target === me) {
      const answer = document.createElement('textarea'); answer.id = 'truthAnswer'; answer.maxLength = 500; answer.placeholder = game.mode === 'truth' ? 'Ta réponse (ou passe ton tour)…' : 'Confirme ou passe ton tour…'; root.append(answer);
      addGameButton(root, 'Répondre', 'truthAnswer', game.id); addGameButton(root, 'Passer', 'truthPass', game.id);
    } else root.append(document.createTextNode(`En attente de ${peerName()} — aucun tour n’est obligatoire.`));
    return;
  }
  if (game.status === 'answered') {
    const response = document.createElement('p'); response.textContent = game.passed ? 'Tour passé sans pression.' : `${game.target === me ? 'Ta réponse' : 'Réponse de ' + peerName()} : ${game.answer}`;
    root.append(response); addGameButton(root, 'Nouveau tour', 'truthNext', game.id); addGameButton(root, 'Terminer', 'gameDecline', game.id);
  }
}

function featurePanel() {
  const panel = document.createElement('section'); panel.className = 'featurePanel'; return panel;
}
function renderCoupleHub(panel) {
  panel.innerHTML = '<p class="featureLead">Votre espace partagé, sans les petits défis ni les suggestions automatiques.</p><div class="featureGrid"><button class="featureCard" data-action="openTasks"><strong>Liste à deux</strong><span>Projets, achats et idées</span></button><button class="featureCard" data-action="openAlbums"><strong>Albums photo</strong><span>Vos souvenirs partagés</span></button><button class="featureCard" data-action="openGames"><strong>Mini-jeux</strong><span>Morpion et pierre-feuille-ciseaux</span></button></div>';
}
const originalRenderFeature = renderFeature;
renderFeature = function () {
  if (!['hub', 'tasks', 'albums', 'games', 'truth', 'distance', 'notifications'].includes(featureState.type)) {
    originalRenderFeature(); return;
  }
  const root = $('#featureContent'); root.innerHTML = '';
  const panel = featurePanel();
  if (featureState.type === 'hub') { $('#featureTitle').textContent = 'Notre univers à deux'; renderCoupleHub(panel); }
  if (featureState.type === 'tasks') { $('#featureTitle').textContent = 'Liste à deux'; renderTasks(panel); }
  if (featureState.type === 'albums') { $('#featureTitle').textContent = 'Albums partagés'; renderAlbums(panel); }
  if (featureState.type === 'games') { $('#featureTitle').textContent = 'Jeux à deux'; renderGames(panel); }
  if (featureState.type === 'truth') {
    $('#featureTitle').textContent = 'Action ou vérité'; renderGames(panel);
  }
  if (featureState.type === 'distance') {
    $('#featureTitle').textContent = 'Notre distance';
    const distance = document.createElement('p'); distance.className = 'featurePrompt';
    distance.textContent = !peerLocation ? 'La position de l’autre personne n’est pas partagée.' : !ownLocation
      ? 'Active le partage de ta position pour calculer la distance.'
      : distanceBetween(ownLocation, peerLocation);
    const sharing = document.createElement('p'); sharing.textContent = ownLocation ? 'Ta position est partagée approximativement.' : 'Le partage est désactivé.';
    const toggle = document.createElement('button'); toggle.className = 'featureAction';
    toggle.textContent = ownLocation ? 'Désactiver le partage' : 'Partager ma position approximative';
    toggle.dataset.action = ownLocation ? 'locationOff' : 'locationOn';
    panel.append(distance, sharing, toggle);
  }
  if (featureState.type === 'notifications') {
    $('#featureTitle').textContent = 'Notifications';
    panel.innerHTML = '<p>Les notifications à application fermée nécessitent la configuration Firebase décrite dans le guide.</p>';
    const prefs = notificationPrefs();
    const labels = { message: 'Messages', voice: 'Vocaux', affection: 'Cœurs et câlins', reaction: 'Réponses et réactions', date: 'Dates importantes', game: 'Jeux et défis' };
    for (const category of pushCategories) {
      const label = document.createElement('label'); label.className = 'switchrow';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = prefs[category]; input.dataset.notification = category;
      label.append(input, document.createTextNode(labels[category])); panel.append(label);
    }
    const enable = document.createElement('button'); enable.className = 'featureAction'; enable.textContent = 'Activer les notifications sur ce téléphone';
    enable.dataset.action = 'pushEnable'; panel.append(enable);
  }
  root.append(panel);
};

function openFeatureWithState(type) { hideMenu(); $('#settings').classList.remove('open'); featureState = { type, prompt: '', choice: null }; renderFeature(); $('#featureModal').classList.add('open'); }
const oldFeatureClick = $('#featureContent').onclick;
$('#featureContent').addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action, id = button.dataset.id, value = button.dataset.value;
  if (!['openTasks', 'openAlbums', 'openGames', 'openDistance', 'openNotifications',
    'openTruth',
    'taskAdd', 'taskToggle', 'taskEdit', 'taskDelete', 'albumCreate', 'albumRename',
    'albumDelete', 'albumAddPhoto', 'albumPhotoDelete', 'gameInvite', 'gameAccept', 'gameDecline',
    'ticMove', 'connectMove', 'rpsMove', 'truthInvite', 'truthCategory', 'truthAnswer',
    'truthPass', 'truthNext', 'locationOn', 'locationOff', 'pushEnable', 'saveDate', 'schedule'].includes(action)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (action === 'openTasks') return openFeatureWithState('tasks');
  if (action === 'openAlbums') return openFeatureWithState('albums');
  if (action === 'openGames') return openFeatureWithState('games');
  if (action === 'openDistance') return openFeatureWithState('distance');
  if (action === 'openNotifications') return openFeatureWithState('notifications');
  if (action === 'openTruth') return openFeatureWithState('games');
  if (action === 'saveDate') {
    const date = $('#featureDate').value;
    if (!date) return toast('Choisis une date.');
    saveDate(date); closeFeature(); return toast('Date importante synchronisée 💗');
  }
  if (action === 'schedule') {
    const text = $('#scheduleText').value.trim();
    const deliverAt = new Date($('#scheduleTime').value).getTime();
    if (!text || !Number.isFinite(deliverAt) || deliverAt < Date.now() + 10000) {
      return toast('Choisis un message et une heure au moins 10 secondes plus tard.');
    }
    if (await scheduleMessage(text, deliverAt)) {
      if ($('#msg').value.trim() === text) { $('#msg').value = ''; resizeText(); }
      closeFeature();
      toast('Message programmé ⏰');
    }
    return;
  }
  if (action === 'taskAdd') {
    const input = $('#taskDraft'), text = input.value.trim(); if (!text) return;
    sharedState.tasks.push({ id: b64(rnd(12)), text, addedBy: me, createdAt: Date.now(), updatedAt: Date.now(), updatedBy: me, done: false });
    await saveShared('tasks'); return renderFeature();
  }
  if (action.startsWith('task')) {
    const task = sharedState.tasks.find(item => item.id === id); if (!task) return;
    if (action === 'taskDelete') task.deleted = true;
    if (action === 'taskToggle') { task.done = button.checked; task.completedBy = button.checked ? me : ''; }
    if (action === 'taskEdit') {
      const text = panelPrompt('Modifier la tâche', task.text); if (text === null) return;
      task.text = text.trim().slice(0, 160); if (!task.text) return;
    }
    task.updatedAt = Date.now(); task.updatedBy = me; await saveShared('tasks'); return renderFeature();
  }
  if (action === 'albumCreate') {
    const name = $('#albumName').value.trim(); if (!name) return toast('Donne un nom à l’album.');
    sharedState.albums.push({ id: b64(rnd(12)), name: name.slice(0, 48), photos: [], createdAt: Date.now(), updatedAt: Date.now(), updatedBy: me });
    await saveShared('albums'); return renderFeature();
  }
  if (action.startsWith('album')) {
    const album = sharedState.albums.find(item => item.id === id); if (!album) return;
    if (action === 'albumDelete') album.deleted = true;
    if (action === 'albumPhotoDelete') {
      const photo = (album.photos || []).find(item => item.id === button.dataset.photo);
      if (!photo) return;
      photo.deleted = true; photo.updatedAt = Date.now();
    }
    if (action === 'albumRename') {
      const name = panelPrompt('Renommer l’album', album.name); if (name === null || !name.trim()) return;
      album.name = name.trim().slice(0, 48);
    }
    if (action === 'albumAddPhoto') return chooseAlbumPhotos(album);
    album.updatedAt = Date.now(); album.updatedBy = me; await saveShared('albums'); return renderFeature();
  }
  if (action === 'gameInvite' || action === 'truthInvite') {
    const kind = action === 'truthInvite' ? 'truth' : button.dataset.kind;
    const game = { id: b64(rnd(12)), kind, status: 'invited', invitedBy: me, createdAt: Date.now(), updatedAt: Date.now(), updatedBy: me };
    if (kind === 'ttt') { game.board = Array(9).fill(''); game.turn = me; }
    if (kind === 'c4') { game.board = Array(42).fill(''); game.turn = me; }
    if (kind === 'rps') game.choices = {};
    sharedState.games.push(game); await saveShared('games', true, 'game'); return renderFeature();
  }
  if (action === 'gameAccept' || action === 'gameDecline') {
    const game = sharedState.games.find(item => item.id === id); if (!game) return;
    game.status = action === 'gameAccept' ? (game.kind === 'truth' ? 'choose' : 'active') : 'deleted';
    game.updatedAt = Date.now(); game.updatedBy = me; await saveShared('games'); return renderFeature();
  }
  if (action === 'ticMove') {
    const game = sharedState.games.find(item => item.id === id); const cell = Number(button.dataset.cell);
    if (!game || game.status !== 'active' || game.turn !== me || game.board[cell]) return;
    game.board[cell] = me === 'andgel' ? 'X' : 'O'; game.winner = gameWinner(game.board);
    game.turn = other; if (game.winner) game.status = 'done';
    game.updatedAt = Date.now(); game.updatedBy = me; await saveShared('games'); return renderFeature();
  }
  if (action === 'connectMove') {
    const game = sharedState.games.find(item => item.id === id), col = Number(button.dataset.col);
    if (!game || game.kind !== 'c4' || game.status !== 'active' || game.turn !== me ||
        !Number.isInteger(col) || col < 0 || col > 6 || game.board[col]) return;
    let row = 5;
    while (row >= 0 && game.board[row * 7 + col]) row--;
    if (row < 0) return;
    game.board[row * 7 + col] = me === 'andgel' ? 'X' : 'O';
    game.winner = connectWinner(game.board);
    game.turn = other;
    if (game.winner) game.status = 'done';
    game.updatedAt = Date.now(); game.updatedBy = me; await saveShared('games'); return renderFeature();
  }
  if (action === 'rpsMove') {
    const game = sharedState.games.find(item => item.id === id); if (!game || game.status !== 'active' || game.choices?.[me]) return;
    game.choices = { ...(game.choices || {}), [me]: value };
    if (game.choices.andgel && game.choices.luna) game.status = 'done';
    game.updatedAt = Date.now(); game.updatedBy = me; await saveShared('games'); return renderFeature();
  }
  if (action === 'truthCategory') {
    const game = sharedState.games.find(item => item.id === id); if (!game || game.status !== 'choose') return;
    game.category = value;
    game.mode = button.dataset.mode === 'dare' ? 'dare' : 'truth';
    const prompts = game.mode === 'truth' ? truthCategories[value] :
      ['Envoie un compliment précis, seulement si tu en as envie.', 'Choisis une chanson qui te fait penser à nous.', 'Raconte un souvenir drôle en trois phrases.'];
    game.prompt = prompts[Math.floor(Math.random() * prompts.length)];
    game.target = other; game.status = 'ask'; game.updatedAt = Date.now(); game.updatedBy = me;
    await saveShared('games'); return renderFeature();
  }
  if (action === 'truthAnswer' || action === 'truthPass') {
    const game = sharedState.games.find(item => item.id === id); if (!game || game.status !== 'ask' || game.target !== me) return;
    const answer = $('#truthAnswer')?.value.trim() || '';
    if (action === 'truthAnswer' && !answer) return toast('Écris ta réponse ou choisis Passer.');
    game.answer = action === 'truthPass' ? '' : answer.slice(0, 500);
    game.passed = action === 'truthPass'; game.status = 'answered'; game.updatedAt = Date.now(); game.updatedBy = me;
    await saveShared('games'); return renderFeature();
  }
  if (action === 'truthNext') {
    const game = sharedState.games.find(item => item.id === id); if (!game) return;
    game.status = 'choose'; game.answer = ''; game.passed = false; game.target = '';
    game.updatedAt = Date.now(); game.updatedBy = me; await saveShared('games'); return renderFeature();
  }
  if (action === 'locationOn') return startLocationSharing();
  if (action === 'locationOff') return stopLocationSharing();
  if (action === 'pushEnable') return enablePush();
}, true);

$('#truthOpen').onclick = () => openFeatureWithState('games');

function panelPrompt(title, value) {
  return window.prompt(title, value);
}

async function chooseAlbumPhotos(album) {
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
  input.onchange = async () => {
    const files = [...input.files];
    for (const file of files) {
      try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL('image/jpeg', 0.66);
        const currentBytes = sharedState.albums.reduce((sum, item) =>
          sum + (item.photos || []).reduce((size, photo) => size + (photo.data?.length || 0), 0), 0);
        if (currentBytes + data.length > 2_500_000) {
          toast('Limite d’album atteinte (environ 2,5 Mo de photos).'); break;
        }
        album.photos = album.photos || [];
        album.photos.push({ id: b64(rnd(12)), data, createdAt: Date.now(), updatedAt: Date.now(), by: me });
      } catch (error) { console.error('Compression album impossible', error); toast('Impossible de lire une photo.'); }
    }
    album.updatedAt = Date.now(); album.updatedBy = me;
    await saveShared('albums'); renderFeature();
  };
  input.click();
}

function distanceBetween(a, b) {
  const r = Math.PI / 180, lat = (b.lat - a.lat) * r, lon = (b.lon - a.lon) * r;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(lon / 2) ** 2;
  const km = 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return km < 0.1 ? 'Vous êtes réunis ❤️' : `Environ ${Math.round(km)} km vous séparent 💞`;
}

function updateDistanceLabel() {
  const label = $('#distanceLabel');
  if (!label) return;
  const peerFresh = peerLocation && Date.now() - peerLocationAt < 12 * 60 * 60 * 1000;
  label.textContent = ownLocation && peerFresh
    ? distanceBetween(ownLocation, peerLocation)
    : '📍 Distance désactivée';
}

async function startLocationSharing() {
  const geolocation = plugin('Geolocation');
  try {
    let position;
    if (geolocation?.requestPermissions) {
      const permission = await geolocation.requestPermissions();
      if (permission.location === 'denied' || permission.coarseLocation === 'denied') throw new Error('Permission de localisation refusée.');
      position = await geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
    } else if (navigator.geolocation) {
      position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 }));
    } else throw new Error('Géolocalisation indisponible sur cet appareil.');
    ownLocation = { lat: Math.round(position.coords.latitude * 1000) / 1000, lon: Math.round(position.coords.longitude * 1000) / 1000 };
    updateDistanceLabel();
    const publish = () => send({ k: 'location', sharing: true, ...ownLocation, updatedAt: Date.now() });
    await publish();
    if (locationWatch !== null && geolocation?.clearWatch) await geolocation.clearWatch({ id: locationWatch });
    locationWatch = null;
    if (geolocation?.watchPosition) {
      locationWatch = await geolocation.watchPosition({ enableHighAccuracy: false, timeout: 30000, maximumAge: 60000 }, async result => {
        if (!result) return;
        const next = { lat: Math.round(result.coords.latitude * 1000) / 1000, lon: Math.round(result.coords.longitude * 1000) / 1000 };
        if (!ownLocation || Math.abs(next.lat - ownLocation.lat) + Math.abs(next.lon - ownLocation.lon) > 0.002) {
          ownLocation = next; updateDistanceLabel(); await publish();
        }
      });
    } else if (navigator.geolocation) {
      locationWatch = navigator.geolocation.watchPosition(async result => {
        const next = { lat: Math.round(result.coords.latitude * 1000) / 1000, lon: Math.round(result.coords.longitude * 1000) / 1000 };
        if (!ownLocation || Math.abs(next.lat - ownLocation.lat) + Math.abs(next.lon - ownLocation.lon) > 0.002) { ownLocation = next; updateDistanceLabel(); await publish(); }
      }, error => console.error('Mise à jour de la position impossible', error), { enableHighAccuracy: false, maximumAge: 60000 });
    }
    renderFeature();
  } catch (error) {
    console.error('Partage de position impossible', error);
    toast(error.message || 'Impossible d’obtenir la position.');
  }
}
async function stopLocationSharing() {
  const geolocation = plugin('Geolocation');
  if (locationWatch !== null) {
    if (geolocation?.clearWatch) await geolocation.clearWatch({ id: locationWatch });
    else navigator.geolocation?.clearWatch(locationWatch);
  }
  locationWatch = null; ownLocation = null;
  updateDistanceLabel();
  await send({ k: 'location', sharing: false, updatedAt: Date.now() });
  renderFeature();
}

function plugin(name) {
  const registered = window.Capacitor?.Plugins?.[name];
  if (registered) return registered;
  const bridge = window.Capacitor;
  if (!bridge?.nativePromise || !bridge?.nativeCallback) return null;
  return new Proxy({}, {
    get(_target, method) {
      if (method === 'addListener') {
        return async (eventName, listener) => {
          const callbackId = bridge.nativeCallback(name, 'addListener', { eventName }, listener);
          return { remove: () => bridge.nativePromise(name, 'removeListener', { callbackId, eventName }) };
        };
      }
      if (name === 'Geolocation' && method === 'watchPosition') {
        return (options, callback) => bridge.nativeCallback(name, 'watchPosition', options, callback);
      }
      return options => bridge.nativePromise(name, String(method), options || {});
    }
  });
}
function notifyIfPushUnavailable(title, body, category) {
  if (!L.pushToken) void showNativeNotification(title, body, category);
}
async function registerPushToken() {
  if (!L.pushToken || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ t: 'pushRegister', token: L.pushToken, preferences: notificationPrefs() }));
}
async function showNativeNotification(title, body, category) {
  if (notificationPrefs()[category] === false || !document.hidden) return;
  const notifications = plugin('LocalNotifications');
  try {
    if (notifications?.schedule) {
      const permission = await notifications.checkPermissions();
      if (permission.display !== 'granted') return;
      await notifications.schedule({ notifications: [{ id: Date.now() % 2147483647, title, body, schedule: { at: new Date(Date.now() + 1000) } }] });
    } else if (window.Notification?.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch (error) { console.error('Notification locale impossible', error); }
}
async function enablePush() {
  const push = plugin('PushNotifications'), local = plugin('LocalNotifications');
  if (!push) { toast('Le module Android de notifications n’est pas inclus dans cet APK.'); return; }
  try {
    if (!pushListenersInstalled) {
      pushListenersInstalled = true;
      await push.addListener('registration', token => { L.pushToken = token.value; void registerPushToken(); });
      await push.addListener('registrationError', error => { console.error('Inscription push impossible', error); toast('Notifications indisponibles : vérifie la configuration Firebase.'); });
      await push.addListener('pushNotificationReceived', notification => {
        if (!document.hidden) return;
      });
    }
    const permission = await push.checkPermissions();
    const receive = permission.receive === 'granted' ? permission : await push.requestPermissions();
    if (receive.receive !== 'granted') { toast('Autorisation de notification refusée.'); return; }
    if (local) {
      const localPermission = await local.checkPermissions();
      if (localPermission.display !== 'granted') await local.requestPermissions();
    }
    await push.register();
    toast('Demande d’activation envoyée à Android.');
  } catch (error) { console.error('Activation des notifications impossible', error); toast('Notifications non configurées sur ce téléphone.'); }
}

const previousOpenFeature = openFeature;
openFeature = function (type) {
  previousOpenFeature(type);
  if (type === 'hub') {
    renderFeature();
  }
};

const oldSettings = $('#settings');
const notificationButton = document.createElement('button');
notificationButton.className = 'setbtn'; notificationButton.textContent = 'Notifications';
notificationButton.onclick = () => openFeatureWithState('notifications');
oldSettings.append(notificationButton);

const prefChangeHandler = event => {
  const category = event.target.dataset.notification;
  if (!pushCategories.includes(category)) return;
  const prefs = notificationPrefs(); prefs[category] = event.target.checked;
  L.setItem('notification-prefs', JSON.stringify(prefs)); void registerPushToken();
};
$('#featureContent').addEventListener('change', prefChangeHandler, true);

let pendingVoiceBlob = null;
let voiceObjectUrl = null;
let voiceDurationTimer = null;
$('#mic').onclick = async () => {
  if (rec) { rec.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    toast('Enregistrement vocal non pris en charge par cette version Android.');
    return;
  }
  let stream;
  try {
    const microphone = plugin('Microphone');
    if (microphone?.requestPermission) {
      const permission = await microphone.requestPermission();
      if (!permission.granted) throw new DOMException('Permission microphone refusée.', 'NotAllowedError');
    }
    stream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true
    } });
    const chunks = [];
    const options = { audioBitsPerSecond: 32000 };
    for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
      if (MediaRecorder.isTypeSupported?.(mime)) { options.mimeType = mime; break; }
    }
    let recorder;
    try { recorder = new MediaRecorder(stream, options); }
    catch { recorder = new MediaRecorder(stream); }
    rec = recorder;
    recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
    recorder.onerror = event => {
      console.error('Erreur enregistrement vocal', event.error || event);
      if (rec === recorder && recorder.state !== 'inactive') recorder.stop();
    };
    recorder.onstop = () => {
      clearInterval(voiceDurationTimer);
      stream.getTracks().forEach(track => track.stop());
      if (rec === recorder) rec = null;
      $('#mic').classList.remove('on');
      $('#mic').textContent = '';
      if (!chunks.length) { toast('Aucun son enregistré.'); return; }
      pendingVoiceBlob = new Blob(chunks, { type: recorder.mimeType || chunks[0].type || 'audio/webm' });
      if (pendingVoiceBlob.size > 2.8 * 1024 * 1024) {
        pendingVoiceBlob = null; toast('Vocal trop lourd (limite 2,8 Mo).'); return;
      }
      if (voiceObjectUrl) URL.revokeObjectURL(voiceObjectUrl);
      voiceObjectUrl = URL.createObjectURL(pendingVoiceBlob);
      $('#voicePreview audio').src = voiceObjectUrl;
      $('#voicePreview').hidden = false;
      $('#mic').setAttribute('aria-label', 'Enregistrer un autre vocal');
    };
    recorder.start(500);
    $('#mic').classList.add('on');
    let seconds = 0;
    $('#mic').textContent = '⏹ 00:00';
    voiceDurationTimer = setInterval(() => {
      seconds++;
      $('#mic').textContent = `⏹ 00:${String(seconds).padStart(2, '0')}`;
      if (seconds >= 30 && rec === recorder) { toast('Vocal limité à 30 secondes.'); recorder.stop(); }
    }, 1000);
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    console.error('Accès au microphone impossible', error);
    const reason = error.name === 'NotAllowedError' || error.name === 'SecurityError'
      ? 'Autorise le microphone dans les réglages Android puis réessaie.'
      : error.name === 'NotFoundError' ? 'Aucun microphone disponible sur cet appareil.'
        : error.name === 'NotReadableError' ? 'Le microphone est déjà utilisé par une autre application.'
          : 'Impossible d’ouvrir le microphone. Vérifie ses autorisations Android.';
    toast(reason);
  }
};

function clearVoicePreview() {
  pendingVoiceBlob = null;
  $('#voicePreview').hidden = true;
  $('#voicePreview audio').removeAttribute('src');
  if (voiceObjectUrl) URL.revokeObjectURL(voiceObjectUrl);
  voiceObjectUrl = null;
}
$('#voiceCancel').onclick = clearVoicePreview;
$('#voiceSend').onclick = async () => {
  if (!pendingVoiceBlob) return;
  const blob = pendingVoiceBlob;
  try {
    const previousCount = hist.length;
    await outgoing({ aud: await du(blob), audioMime: blob.type });
    if (hist.length > previousCount) clearVoicePreview();
  } catch (error) {
    console.error('Envoi du message vocal impossible', error);
    toast('Vocal non envoyé. Il reste disponible pour réessayer.');
  }
};

const compactUiStyle = document.createElement('style');
compactUiStyle.textContent = `
  .menuitem[hidden]{display:none!important}
  #settings [hidden]{display:none!important}
  .distanceLabel{border:0;background:transparent;color:var(--muted);font-size:11px;padding:2px 6px 2px 0;text-align:left}
  .taskComposer{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}
  .taskComposer input{min-width:0}
  .taskComposer .featureAction{width:auto;padding:10px 15px}
  .sharedList{display:grid;gap:9px}
  .sharedRow{display:grid;grid-template-columns:24px minmax(0,1fr);gap:10px;align-items:center;padding:12px;background:#302641;border:1px solid #493856;border-radius:15px}
  .sharedRow input[type=checkbox]{width:20px;height:20px;accent-color:#d6a8ff}
  .taskDetails{min-width:0;display:grid;gap:3px}
  .taskText{overflow-wrap:anywhere}
  .taskText.isDone{text-decoration:line-through;color:var(--muted)}
  .taskDetails small{color:var(--muted);font-size:11px}
  .taskActions{grid-column:2;display:flex;gap:7px}
  .taskActions button{background:#3a2f4d;border:1px solid #514065;border-radius:10px;padding:7px 10px;font-size:12px}
  .connectBoard{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;padding:7px;background:#4b3b66;border-radius:14px}
  .connectCell{aspect-ratio:1;border-radius:50%;background:#211b32;font-size:clamp(14px,5vw,25px);padding:0}
  .connectCell:disabled{opacity:1}
  .updateOffer{margin-top:10px;padding:12px;border:1px solid #604b77;border-radius:15px;background:#302641;text-align:left}
  .updateOffer p{margin:0 0 8px;color:var(--ink);font-size:13px}
  .updateOffer button{width:100%;padding:11px;border-radius:12px;background:linear-gradient(135deg,#c79aee,#e6a9c9);color:#281a34;font-weight:700}
`;
document.head.append(compactUiStyle);

for (const id of ['truthOpen', 'chillOpen', 'flirtOpen', 'scheduleOpen', 'memoryOpen']) {
  const control = $(`#${id}`);
  if (control) control.hidden = true;
}
for (const id of ['questionOpen', 'moodOpen']) {
  const control = $(`#${id}`);
  if (control) control.hidden = true;
}

const distanceLabel = document.createElement('button');
distanceLabel.id = 'distanceLabel';
distanceLabel.type = 'button';
distanceLabel.className = 'distanceLabel';
distanceLabel.setAttribute('aria-label', 'Voir la distance et les options de partage de position');
$('#ttl2').after(distanceLabel);
distanceLabel.onclick = () => openFeatureWithState('distance');
updateDistanceLabel();

const sendButton = $('#snd');
const originalSendClick = sendButton.onclick;
let sendHoldTimer = null;
let sendHoldTriggered = false;
sendButton.title = 'Maintenir 1,2 seconde pour programmer le message';
sendButton.setAttribute('aria-label', 'Envoyer — maintenir pour programmer');
sendButton.onclick = event => {
  if (sendHoldTriggered) {
    event.preventDefault();
    sendHoldTriggered = false;
    return;
  }
  originalSendClick.call(sendButton, event);
};
sendButton.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  sendHoldTriggered = false;
  clearTimeout(sendHoldTimer);
  sendHoldTimer = setTimeout(() => {
    const text = $('#msg').value.trim();
    if (!text) { toast('Écris un message avant de le programmer.'); return; }
    sendHoldTriggered = true;
    openFeatureWithState('schedule');
    requestAnimationFrame(() => {
      const field = $('#scheduleText');
      if (field) field.value = text;
    });
  }, 1200);
});
for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
  sendButton.addEventListener(eventName, () => clearTimeout(sendHoldTimer));
}

function renderUpdateOffer(versionName, apkUrl, sha256, ready = false, failed = false) {
  const panel = document.getElementById('updateOffer') || document.createElement('div');
  panel.id = 'updateOffer';
  panel.className = 'updateOffer';
  panel.replaceChildren();
  const message = document.createElement('p');
  message.textContent = ready
    ? `La mise à jour ${versionName} est téléchargée et prête.`
    : failed ? `Téléchargement de ${versionName} interrompu. Réessaie quand tu es en Wi-Fi.`
      : `Nouvelle version ${versionName} : téléchargement en cours…`;
  const install = document.createElement('button');
  install.type = 'button';
  install.textContent = ready ? 'Installer la mise à jour' : failed ? 'Réessayer le téléchargement' : 'Téléchargement…';
  install.disabled = !ready && !failed;
  install.onclick = async () => {
    const updater = plugin('AppUpdater');
    if (!updater) { toast('Le module de mise à jour est absent de cette version.'); return; }
    install.disabled = true;
    try {
      if (ready) {
        const result = await updater.installDownloadedApk();
        if (result?.permissionRequired) toast('Autorise l’installation depuis cette source, puis reviens ici et réessaie.');
      } else {
        await updater.downloadApk({ url: apkUrl, sha256 });
        renderUpdateOffer(versionName, apkUrl, sha256, true);
      }
    } catch (error) {
      console.error('Mise à jour impossible', error);
      renderUpdateOffer(versionName, apkUrl, sha256, false, true);
      toast(error.message || 'Impossible de télécharger la mise à jour.');
    } finally {
      install.disabled = false;
    }
  };
  panel.append(message, install);
  const lock = $('#lock');
  if (!panel.isConnected) lock.insertBefore(panel, $('#err'));
  panel.hidden = false;
}

async function checkForAppUpdate() {
  const config = window.LUNA_UPDATE_CONFIG || {};
  const repository = String(config.repository || '');
  if (window.Capacitor?.getPlatform?.() !== 'android' || !/^[\w.-]+\/[\w.-]+$/.test(repository)) return;
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`GitHub API a répondu ${response.status}`);
    const release = await response.json();
    if (release.draft || release.prerelease) return;
    const body = String(release.body || '');
    const versionCode = Number(body.match(/VersionCode:\s*(\d+)/i)?.[1] || release.tag_name?.match(/(\d+)$/)?.[1]);
    if (!Number.isSafeInteger(versionCode) || versionCode <= Number(config.versionCode || 1)) return;
    const sha256 = body.match(/SHA256:\s*([a-f\d]{64})/i)?.[1]?.toLowerCase();
    const apk = release.assets?.find(asset => asset.name === 'Luna-Andgel.apk');
    if (!sha256 || !apk?.browser_download_url) throw new Error('Métadonnées de mise à jour manquantes.');
    const updater = plugin('AppUpdater');
    if (!updater?.isDownloaded || !updater?.downloadApk) throw new Error('Module de mise à jour absent.');
    const versionName = String(release.name || release.tag_name);
    const cached = await updater.isDownloaded({ sha256 });
    renderUpdateOffer(versionName, apk.browser_download_url, sha256, !!cached.ready);
    if (!cached.ready) {
      try {
        await updater.downloadApk({ url: apk.browser_download_url, sha256 });
        renderUpdateOffer(versionName, apk.browser_download_url, sha256, true);
      } catch (error) {
        console.error('Téléchargement de la mise à jour impossible', error);
        renderUpdateOffer(versionName, apk.browser_download_url, sha256, false, true);
      }
    }
  } catch (error) {
    console.error('Vérification des mises à jour impossible', error);
  }
}
window.addEventListener('load', () => { void checkForAppUpdate(); }, { once: true });
