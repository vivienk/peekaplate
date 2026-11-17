// Existing prepared-menu presentation, shared without importing its API controller.
import type { PreparedMenuPreview } from '@peekaplate/contracts';
import { useState } from 'react';

export function DraftMenu({
  preview,
}: {
  preview: {
    content: {
      restaurant: { name: string };
      categories: {
        category_id: string;
        name: string;
        dishes: (
          | { complete: false; dish_id: string }
          | {
              complete: true;
              dish_id: string;
              name: string;
              description: string | null;
              price: { amount: string; currency: string };
              images: { card: { url: string; alt: string } };
              ingredients: { name: string }[];
              allergens: string[] | null;
            }
        )[];
      }[];
    };
  };
}) {
  const [categoryId, setCategoryId] = useState('');
  const categories = preview.content.categories;
  return (
    <div aria-label="Draft diner menu" role="region">
      <h2>{preview.content.restaurant.name}</h2>
      <div className="pp-draft-menu__tabs" role="group" aria-label="Menu categories">
        <button
          type="button"
          className="pp-draft-menu__tab"
          aria-pressed={!categoryId}
          onClick={() => setCategoryId('')}
        >
          All
        </button>
        {categories.map((category) => (
          <button
            key={category.category_id}
            type="button"
            className="pp-draft-menu__tab"
            aria-pressed={categoryId === category.category_id}
            onClick={() => setCategoryId(category.category_id)}
          >
            {category.name}
          </button>
        ))}
      </div>
      {categories
        .filter((category) => !categoryId || category.category_id === categoryId)
        .map((category) => (
          <section key={category.category_id} className="pp-draft-menu__section">
            <h3>{category.name}</h3>
            {category.dishes.map((dish) => (
              <article key={dish.dish_id} className="pp-draft-menu__dish">
                {dish.complete ? (
                  <>
                    <img
                      src={dish.images.card.url}
                      alt={dish.images.card.alt}
                      referrerPolicy="no-referrer"
                    />
                    <div>
                      <h4>{dish.name}</h4>
                      <p className="pp-draft-menu__price">
                        {new Intl.NumberFormat('en', {
                          style: 'currency',
                          currency: dish.price.currency,
                        }).format(Number(dish.price.amount))}
                      </p>
                      {dish.description && <p>{dish.description}</p>}
                      <details>
                        <summary>Ingredients and allergens</summary>
                        <p>
                          {dish.ingredients.map((ingredient) => ingredient.name).join(', ') ||
                            'No ingredients listed.'}
                        </p>
                        <p>
                          {dish.allergens === null
                            ? 'Allergen information not provided.'
                            : dish.allergens.length
                              ? `Declared allergens: ${dish.allergens.join(', ')}.`
                              : 'No allergens declared.'}
                        </p>
                      </details>
                    </div>
                  </>
                ) : (
                  <p className="pp-draft-menu__missing">This dish is not ready to display.</p>
                )}
              </article>
            ))}
          </section>
        ))}
    </div>
  );
}
