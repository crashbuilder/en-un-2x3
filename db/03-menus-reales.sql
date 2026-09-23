-- db/03-menus-reales.sql
-- Inserción de los menús reales procesados mediante Visión Artificial.

INSERT INTO merchants (id, name, category, menu, specialty, zone, sponsored, ad_plan)
VALUES 
(
  gen_random_uuid(), 
  'Sr. Loquillo''s', 
  ARRAY['asados', 'fritos', 'corriente'], 
  '[
    {"item": "Chicharrón BBQ", "price": 17000, "prep_min": 15, "available": true},
    {"item": "Mojarra frita", "price": 20000, "prep_min": 20, "available": true},
    {"item": "Pollo guisado", "price": 12000, "prep_min": 10, "available": true},
    {"item": "Gallina guisada", "price": 20000, "prep_min": 15, "available": true},
    {"item": "Lomo de cerdo asado", "price": 15000, "prep_min": 15, "available": true},
    {"item": "Asado tradicional (con papa/patacón y ensalada)", "price": 20000, "prep_min": 15, "available": true}
  ]'::jsonb, 
  'Fritos, guisados, asados y desmechados.', 
  'Centro', 
  false, 
  NULL
),
(
  gen_random_uuid(), 
  'Restaurante Donde Isne', 
  ARRAY['corriente', 'asados', 'comida tipica'], 
  '[
    {"item": "Gallina guisada", "price": 20000, "prep_min": 15, "available": true},
    {"item": "Chivo en coco", "price": 15000, "prep_min": 15, "available": true},
    {"item": "Chicharrones BBQ", "price": 25000, "prep_min": 20, "available": true},
    {"item": "Bocachico frito", "price": 25000, "prep_min": 25, "available": true},
    {"item": "Sopa grande", "price": 12000, "prep_min": 5, "available": true},
    {"item": "Pastel masa cerdo", "price": 12000, "prep_min": 10, "available": true}
  ]'::jsonb, 
  'Comida casera con el auténtico sabor de nuestra tierra. Calle 16#17-81 Barrio El Campo.', 
  'El Campo',
  true, 
  'destacado'
),
(
  gen_random_uuid(), 
  'La Fressería', 
  ARRAY['postres', 'fresas', 'dulces'], 
  '[
    {"item": "Fresas con crema 9oz (1 salsa + 1 topping)", "price": 12000, "prep_min": 5, "available": true},
    {"item": "Fresas con crema 12oz (1 salsa + 1 topping)", "price": 15000, "prep_min": 5, "available": true},
    {"item": "Fresas con crema 16oz (1 salsa + 1 topping)", "price": 18000, "prep_min": 5, "available": true},
    {"item": "Topping adicional", "price": 2500, "prep_min": 0, "available": true}
  ]'::jsonb, 
  'Más que fresas, una experiencia. Fresas con crema artesanal.', 
  'Centro',
  false, 
  NULL
),
(
  gen_random_uuid(), 
  'Restaurante Maye', 
  ARRAY['corriente', 'asados', 'casera'], 
  '[
    {"item": "Corriente - Cerdo guisado", "price": 13000, "prep_min": 10, "available": true},
    {"item": "Corriente - Chivo en coco", "price": 13000, "prep_min": 10, "available": true},
    {"item": "Carne asada", "price": 17000, "prep_min": 15, "available": true},
    {"item": "Pechuga gratinada", "price": 20000, "prep_min": 15, "available": true},
    {"item": "Menú Especial - Bocachico frito", "price": 25000, "prep_min": 20, "available": true}
  ]'::jsonb, 
  'Sabores que te hacen sentir en casa. Corrientes y asados especiales.', 
  'Centro',
  true, 
  'estado'
);
