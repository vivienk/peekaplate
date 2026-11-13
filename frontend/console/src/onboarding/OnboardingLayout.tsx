// FE-05/FE-06: the page around the owner onboarding screens (S05–S08), from the Figma Navbar
// component: logo and wordmark on the left, "Owner Portal" with the restaurant name and the account
// icon on the right, then the screen's card.
import type { ReactNode } from 'react';
import logo from '../auth/assets/logo.png';
import userIcon from './assets/user.svg';
import './onboarding.css';

export function OnboardingLayout({
  restaurantName,
  children,
}: {
  // Shown under "Owner Portal". Before S05 is saved there is no name yet.
  restaurantName?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="pp-onboard">
      <div className="pp-onboard__container">
        <header className="pp-onboard__nav">
          <p className="pp-onboard__brand">
            <img src={logo} alt="" width="32" height="32" />
            <span>PeekaPlate</span>
          </p>
          <div className="pp-onboard__account">
            <p className="pp-onboard__portal">
              <span className="pp-onboard__portal-label">Owner Portal</span>
              {restaurantName && <span className="pp-onboard__venue">{restaurantName}</span>}
            </p>
            <span className="pp-onboard__avatar" aria-hidden="true">
              <img src={userIcon} alt="" width="32" height="32" />
            </span>
          </div>
        </header>
        <main className="pp-onboard__card">{children}</main>
      </div>
    </div>
  );
}
