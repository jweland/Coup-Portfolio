function canStartGame(players, maxPlayers = 6) {
  return Array.isArray(players) &&
    players.length >= 2 &&
    players.length <= maxPlayers &&
    players.every(player => player.ready === true);
}

function isCurrentPlayer(game, username) {
  return Boolean(game && game.players[game.currentPlayer]?.name === username);
}

module.exports = { canStartGame, isCurrentPlayer };
