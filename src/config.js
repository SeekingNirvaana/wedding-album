// Event setup — edit here, redeploy, done.
// Time windows decide which event a photo is auto-tagged with, based on when it was taken (IST).
// Guests can always change the event before uploading.

export const CONFIG = {
  title: 'Anoop weds Sanghmitra',
  subtitle: 'From Kashi to Prayagraj · 24–27 November 2026',

  sides: {
    groom: { label: "Groom's side", place: 'Varanasi' },
    bride: { label: "Bride's side", place: 'Prayagraj' },
    joint: { label: 'Together', place: 'Willow Winds, Prayagraj' },
  },

  events: [
    {
      id: 'mehendi',
      name: 'Mehendi Night',
      when: 'Tue, 24 Nov · 7:00 PM',
      sides: ['groom', 'bride'],
      art: '/art/art-mehendi.webp',
      from: '2026-11-24T12:00:00+05:30',
      to: '2026-11-25T06:00:00+05:30',
    },
    {
      id: 'haldi',
      name: 'Haldi',
      when: 'Wed, 25 Nov · 11:00 AM',
      sides: ['groom', 'bride'],
      art: '/art/art-haldi.webp',
      from: '2026-11-25T06:00:00+05:30',
      to: '2026-11-26T12:00:00+05:30',
    },
    {
      id: 'shaadi',
      name: 'Shaadi',
      when: 'Thu, 26 Nov · 8:00 PM',
      sides: ['joint'],
      art: '/art/art-shaadi.webp',
      from: '2026-11-26T12:00:00+05:30',
      to: '2026-11-27T04:30:00+05:30',
    },
    {
      id: 'vidai',
      name: 'Vidai',
      when: 'Fri, 27 Nov · 6:00 AM',
      sides: ['joint'],
      art: '/art/art-vidai.webp',
      from: '2026-11-27T04:30:00+05:30',
      to: '2026-11-27T18:00:00+05:30',
    },
  ],

  // Catch-all for photos taken outside every window above
  otherEvent: { id: 'other', name: 'Moments', when: 'Before & after', sides: ['groom', 'bride', 'joint'] },

  limits: {
    maxUploadBytes: 15 * 1024 * 1024,
    maxThumbBytes: 1024 * 1024,
    maxFacesPerPhoto: 80,
    maxMatchResults: 600,
  },
};

export function allEvents() {
  return [...CONFIG.events, CONFIG.otherEvent];
}

export function eventById(id) {
  return allEvents().find((e) => e.id === id) || null;
}
