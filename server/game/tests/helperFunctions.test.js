const { shuffle } = require('../helperFunctions');

describe('shuffle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('shuffles in place with Fisher-Yates and only selects valid indices', () => {
    const cards = ['a', 'b', 'c'];
    const random = jest.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.99);

    const result = shuffle(cards);

    expect(result).toBe(cards);
    expect(cards).toEqual(['c', 'b', 'a']);
    expect(random).toHaveBeenCalledTimes(2);
  });

  test('preserves the contents and multiplicity of a Coup deck', () => {
    const deck = [
      'duke', 'duke', 'duke',
      'assassin', 'assassin', 'assassin',
      'captain', 'captain', 'captain',
      'ambassador', 'ambassador', 'ambassador',
      'contessa', 'contessa', 'contessa'
    ];
    const expectedCounts = Object.fromEntries(
      [...new Set(deck)].map(card => [card, deck.filter(value => value === card).length])
    );
    jest.spyOn(Math, 'random').mockReturnValue(0.5);

    const shuffledDeck = shuffle(deck);
    const actualCounts = Object.fromEntries(
      [...new Set(shuffledDeck)].map(card => [card, shuffledDeck.filter(value => value === card).length])
    );

    expect(shuffledDeck).toHaveLength(15);
    expect(actualCounts).toEqual(expectedCounts);
  });

  test('returns empty and single-card arrays unchanged', () => {
    const emptyDeck = [];
    const singleCard = ['duke'];
    const random = jest.spyOn(Math, 'random');

    expect(shuffle(emptyDeck)).toBe(emptyDeck);
    expect(shuffle(singleCard)).toBe(singleCard);
    expect(random).not.toHaveBeenCalled();
  });
});
