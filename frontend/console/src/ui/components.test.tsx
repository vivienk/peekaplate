import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Card } from './Card';
import { Input } from './Input';
import { Nav, NavIcon } from './Nav';
import { Text } from './Text';

describe('console UI wrappers', () => {
  it('Button renders variant classes', () => {
    expect(renderToStaticMarkup(<Button variant="action">Save</Button>)).toContain(
      'pp-button pp-button--action',
    );
    expect(renderToStaticMarkup(<Button variant="outline">Cancel</Button>)).toContain(
      'pp-button pp-button--outline',
    );
    expect(renderToStaticMarkup(<Button variant="text">More</Button>)).toContain(
      'pp-button pp-button--text',
    );
  });

  it('Button merges className and passes attributes', () => {
    const html = renderToStaticMarkup(
      <Button className="extra" disabled aria-disabled="true">
        X
      </Button>,
    );
    expect(html).toContain('extra');
    expect(html).toContain('disabled');
    expect(html).toContain('aria-disabled="true"');
  });

  it('Button accepts event handlers without throwing', () => {
    const onClick = vi.fn();
    expect(() => renderToStaticMarkup(<Button onClick={onClick}>Click</Button>)).not.toThrow();
  });

  it('Card renders base and elevated classes', () => {
    expect(renderToStaticMarkup(<Card>Body</Card>)).toContain('pp-card');
    expect(renderToStaticMarkup(<Card elevated>Body</Card>)).toContain('pp-card--elevated');
  });

  it('Card merges className', () => {
    expect(renderToStaticMarkup(<Card className="wrap">Body</Card>)).toContain('wrap');
  });

  it('Input renders pp-input class and merges className', () => {
    const html = renderToStaticMarkup(<Input className="field" placeholder="Name" />);
    expect(html).toContain('pp-input');
    expect(html).toContain('field');
    expect(html).toContain('placeholder="Name"');
  });

  it('Input forwards aria-invalid and disabled', () => {
    const html = renderToStaticMarkup(<Input aria-invalid="true" disabled />);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('disabled');
  });

  it('Input accepts a ref prop without throwing', () => {
    const ref = React.createRef<HTMLInputElement>();
    expect(() => renderToStaticMarkup(<Input ref={ref} />)).not.toThrow();
  });

  it('Nav renders pp-nav class', () => {
    expect(renderToStaticMarkup(<Nav>Items</Nav>)).toContain('pp-nav');
  });

  it('NavIcon renders state classes and aria-disabled', () => {
    const hover = renderToStaticMarkup(<NavIcon hover>Icon</NavIcon>);
    expect(hover).toContain('pp-nav__icon--hover');
    const disabled = renderToStaticMarkup(<NavIcon disabled>Icon</NavIcon>);
    expect(disabled).toContain('pp-nav__icon--disabled');
    expect(disabled).toContain('aria-disabled="true"');
  });

  it('Text renders variant classes and tag', () => {
    expect(renderToStaticMarkup(<Text variant="h1">Title</Text>)).toContain('pp-text--h1');
    expect(renderToStaticMarkup(<Text variant="paragraph-2">Note</Text>)).toContain(
      'pp-text--paragraph-2',
    );
  });
});
