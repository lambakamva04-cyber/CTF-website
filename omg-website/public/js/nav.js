// The phone menu (a <details> in the top bar) closes once one of its links is
// chosen, on a tap outside it, or on Escape. A link to a section of the same
// page doesn't reload the page, so without this the menu would stay open.
for (const menu of document.querySelectorAll('details.mnav')) {
  menu.addEventListener('click', (event) => {
    if (event.target.closest('a')) menu.open = false;
  });
  document.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  });
}
