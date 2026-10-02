'use strict';
/* ================================================================= the contact page
 * ONE constant, and every link on the page comes from it. The alternative -- an address
 * in the HTML and the same address in a mailto in the JS -- is how a page ends up
 * publishing two different ones. */
const CONTACT = {
  name: 'Gustavo Formento',
  // What I can state without asserting anything I have not verified. A professional
  // title on a public page is a claim about a person, not a nicety.
  role: 'The author of this service',
  // No address on a public page: contact is LinkedIn and GitHub.
  email: '',
  linkedin: 'https://www.linkedin.com/in/gustavoogomesss/',
  github: 'https://github.com/gomesgustavoo',
};

function renderContact() {
  const who = $('contactWho');
  const links = $('contactLinks');
  if (who) who.innerHTML = `<b>${esc(CONTACT.name)}</b><br><span class="hint">${esc(CONTACT.role)}</span>`;
  if (!links) return;
  const rows = [];
  if (CONTACT.email) {
    rows.push(`<li><span>Email</span><a href="mailto:${esc(CONTACT.email)}?subject=${
      encodeURIComponent('Custom segmentation model')}">${esc(CONTACT.email)}</a></li>`);
  }
  if (CONTACT.linkedin) {
    rows.push(`<li><span>LinkedIn</span><a href="${esc(CONTACT.linkedin)}" target="_blank"
      rel="noopener">${esc(CONTACT.linkedin.replace(/^https?:\/\/(www\.)?/, ''))}</a></li>`);
  }
  if (CONTACT.github) {
    rows.push(`<li><span>Code</span><a href="${esc(CONTACT.github)}" target="_blank"
      rel="noopener">${esc(CONTACT.github.replace(/^https?:\/\/(www\.)?/, ''))}</a></li>`);
  }
  links.innerHTML = rows.join('');
}

