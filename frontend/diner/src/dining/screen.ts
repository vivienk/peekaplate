import { type DiningMenu, DiningMenuSchema } from '@peekaplate/contracts';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { renderDishDetail } from '../menu/dishDetail';
import { createDiningCart } from './cart';
import locations from './locations.json';
import region from './region.json';

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export async function mountDining(container: HTMLElement) {
  const route = new URL(location.href);
  route.searchParams.set('experience', 'quest');
  history.replaceState(null, '', route);

  const cart = createDiningCart();
  let menu: DiningMenu | undefined;
  let map: L.Map | undefined;
  let disposeDetail: (() => void) | undefined;
  let loading: AbortController | undefined;
  let selected = locations[0]!;
  let busy = false;
  const configured = String(import.meta.env.VITE_DINING_API_BASE || '').replace(/\/$/, '');
  const api = configured || '/public/dining';
  const cleanup = () => {
    map?.remove();
    map = undefined;
    disposeDetail?.();
    disposeDetail = undefined;
    loading?.abort();
  };
  const header = (title: string, back = false) =>
    `<header class="pp-dining__header"><div><p>PEEKAPLATE · DISCOVER & DINE</p><h1>${escape(title)}</h1></div><button data-back>${back ? '← Restaurants' : 'Classic menu'}</button></header>`;
  const bindBack = (action: () => void) =>
    container.querySelector('[data-back]')!.addEventListener('click', action);
  const showMap = () => {
    cleanup();
    menu = undefined;
    container.innerHTML = `<main class="pp-dining">${header('Find your next favourite.')}<p>Explore NōKA, Son & Garden and Farmhouse Kitchen. Choose a location, explore its menu and submit an unpaid pickup request.</p><div class="pp-dining__layout"><section class="pp-dining__locations" aria-label="Restaurants"><label>Restaurant brand <select aria-label="Restaurant brand"><option value="">All restaurants</option>${[...new Set(locations.map((l) => l.brand))].map((b) => `<option>${escape(b)}</option>`).join('')}</select></label><p>${locations.length} locations · California & Oregon</p><div data-list></div></section><section><div class="pp-dining__map" role="region" aria-label="Restaurant map"></div><p data-map-status role="status">Regional map · select a pin or restaurant card. Street addresses are listed on the cards.</p><small>Locations from the restaurants’ official websites, checked 14 November 2026. Ordering availability is confirmed separately.</small></section></div></main>`;
    bindBack(() => {
      const url = new URL(location.href);
      url.searchParams.set('experience', 'menu');
      location.assign(url.href);
    });
    const mapHost = container.querySelector<HTMLElement>('.pp-dining__map')!;
    map = L.map(mapHost, { scrollWheelZoom: false }).setView([37.79, -122.3], 10);
    L.geoJSON(region as Parameters<typeof L.geoJSON>[0], {
      style: { color: '#a9b9a7', weight: 1, fillColor: '#edf0df', fillOpacity: 1 },
    }).addTo(map);
    map.attributionControl.addAttribution('Regional outlines: Natural Earth · public domain');
    const markers = L.layerGroup().addTo(map);
    const draw = (brand: string) => {
      const list = locations.filter((l) => !brand || l.brand === brand);
      container.querySelector('[data-list]')!.innerHTML = list
        .map(
          (l) =>
            `<button class="pp-dining__location" data-location="${l.id}"><strong>${escape(l.brand)}</strong><span>${escape(l.city)}</span><small>${escape(l.address)}</small></button>`,
        )
        .join('');
      markers.clearLayers();
      list.forEach((l) => {
        const marker = L.marker([l.latitude, l.longitude], {
          icon: L.divIcon({ className: 'pp-dining__pin', html: '●', iconSize: [32, 32] }),
          title: l.brand + ' ' + l.city,
          alt: l.brand + ' ' + l.city,
        }).addTo(markers);
        marker.on('click', () => void showRestaurant(l.id));
      });
      container
        .querySelectorAll<HTMLButtonElement>('[data-location]')
        .forEach((b) =>
          b.addEventListener('click', () => void showRestaurant(b.dataset.location!)),
        );
    };
    draw('');
    container
      .querySelector('select')!
      .addEventListener('change', (e) => draw((e.target as HTMLSelectElement).value));
    const all = L.latLngBounds(locations.map((l) => L.latLng(l.latitude, l.longitude)));
    map.fitBounds(all, { padding: [35, 35] });
  };
  const showRestaurant = async (id: string) => {
    cleanup();
    selected = locations.find((l) => l.id === id)!;
    menu = undefined;
    loading = new AbortController();
    const attempt = loading;
    container.innerHTML = `<main class="pp-dining">${header(selected.brand, true)}<p>${escape(selected.address)}</p><p role="status">Loading this location’s menu…</p></main>`;
    bindBack(showMap);
    try {
      const response = await fetch(`${api}/locations/${selected.id}/menu`, {
        signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) throw new Error('unavailable');
      const result = DiningMenuSchema.parse(await response.json());
      if (attempt.signal.aborted) return;
      if (result.locationId !== id) throw new Error('identity');
      menu = result;
      cart.setMenu(result);
      renderMenu();
    } catch {
      if (attempt.signal.aborted) return;
      container.innerHTML = `<main class="pp-dining">${header(selected.brand, true)}<p>${escape(selected.address)}</p><section class="pp-dining__empty"><h2>Online ordering isn’t connected yet.</h2><p>You can view this restaurant’s source menu. PeekaPlate cannot submit orders for this location until its menu and receiving service are connected.</p><a href="${escape(selected.menuSource)}" target="_blank" rel="noopener">View restaurant menu ↗</a><a href="${escape(selected.website)}" target="_blank" rel="noopener">Restaurant website ↗</a><button data-retry>Try again</button></section></main>`;
      bindBack(showMap);
      container
        .querySelector('[data-retry]')!
        .addEventListener('click', () => void showRestaurant(id));
    }
  };
  const renderMenu = () => {
    disposeDetail?.();
    disposeDetail = undefined;
    container.innerHTML = `<main class="pp-dining">${header(selected.brand, true)}<p>${escape(selected.address)}</p><p>Pickup request · no payment collected · restaurant confirmation required</p><div class="pp-dining__menu">${menu!.items.map((i) => `<article>${i.image ? `<img src="${escape(i.image)}" alt="${escape(i.name)}" loading="lazy"/>` : ''}<h2>${escape(i.name)}</h2><p>${escape(i.description)}</p><strong>${money(i.unitCents)}</strong><button data-detail="${i.id}">View dish & portion</button><label>Quantity for ${escape(i.name)} <input type="number" min="0" max="20" value="${cart.quantity(i.id)}" data-quantity="${i.id}" ${menu!.acceptingOrders ? '' : 'disabled'}/></label></article>`).join('')}</div><footer class="pp-dining__cart"><p role="status" data-cart-status></p><button data-cart ${menu!.acceptingOrders ? '' : 'disabled'}>Review order</button></footer></main>`;
    bindBack(showMap);
    const update = () => {
      const lines = cart.lines();
      container.querySelector('[data-cart-status]')!.textContent = menu!.acceptingOrders
        ? `${lines.reduce((s, l) => s + l.quantity, 0)} items · subtotal ${money(lines.reduce((s, l) => s + l.quantity * l.item.unitCents, 0))}`
        : 'This location is not accepting orders.';
    };
    update();
    container.querySelectorAll<HTMLInputElement>('[data-quantity]').forEach((input) =>
      input.addEventListener('change', () => {
        try {
          cart.set(input.dataset.quantity!, Number(input.value));
        } catch {
          input.value = String(cart.quantity(input.dataset.quantity!));
        }
        update();
      }),
    );
    container.querySelectorAll<HTMLButtonElement>('[data-detail]').forEach((b) =>
      b.addEventListener('click', () => {
        const item = menu!.items.find((i) => i.id === b.dataset.detail)!;
        disposeDetail = renderDishDetail(
          container,
          {
            kind: 'complete',
            dishId: item.id,
            dishRevisionId: item.revisionId,
            categoryId: 'dining',
            categoryName: 'Menu',
            name: item.name,
            description: item.description,
            price: { amount: (item.unitCents / 100).toFixed(2), currency: 'USD' },
            ingredients: [],
            allergens: [],
            dietary: [],
            images: item.image
              ? {
                  card: { url: item.image, width: 640, height: 640, alt: item.name },
                  detail: { url: item.image, width: 640, height: 640, alt: item.name },
                }
              : null,
            ...(item.portion ? { portion: item.portion } : {}),
          },
          renderMenu,
        );
        container.querySelector('.pp-detail__save')?.remove();
      }),
    );
    container.querySelector('[data-cart]')!.addEventListener('click', () => {
      if (cart.lines().length) showCart();
      else container.querySelector('[data-cart-status]')!.textContent = 'Choose at least one dish.';
    });
  };
  const showCart = () => {
    const lines = cart.lines();
    container.innerHTML = `<main class="pp-dining">${header('Review your pickup request', true)}<h2>${escape(selected.brand)} · ${escape(selected.city)}</h2><p>${escape(selected.address)}</p><ul>${lines.map((l) => `<li>${l.quantity} × ${escape(l.item.name)} — ${money(l.quantity * l.item.unitCents)}</li>`).join('')}</ul><h2>Subtotal ${money(lines.reduce((s, l) => s + l.quantity * l.item.unitCents, 0))}</h2><p>No payment is collected here. Taxes and any additional charges are not included in this subtotal. This submits a request; wait for restaurant confirmation before collecting.</p><button data-submit>Submit order without payment</button><p role="status" data-result></p></main>`;
    bindBack(() => {
      if (!busy) renderMenu();
    });
    container
      .querySelector<HTMLButtonElement>('[data-submit]')!
      .addEventListener('click', async (e) => {
        if (busy) return;
        busy = true;
        const button = e.currentTarget as HTMLButtonElement;
        button.disabled = true;
        const result = container.querySelector<HTMLElement>('[data-result]')!;
        result.textContent = 'Submitting…';
        try {
          const receipt = await cart.submit(`${api}/locations/${selected.id}/orders`);
          result.textContent = `Request received. Order ${receipt.orderId}. Unpaid — awaiting restaurant confirmation. Keep this reference for pickup.`;
          button.textContent = 'Request submitted';
        } catch (error) {
          result.textContent =
            error instanceof Error ? error.message : 'Order not confirmed. Please retry.';
          button.disabled = false;
        } finally {
          busy = false;
        }
      });
  };
  showMap();
  window.addEventListener('pagehide', cleanup, { once: true });
}
