-- db/04-la-jefa.sql

-- Asegurarnos de que exista la columna de teléfono para identificar aliados
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS phone VARCHAR(20);

-- Insertar el restaurante de prueba
INSERT INTO merchants (id, name, phone, category, menu, specialty, zone, sponsored)
VALUES (
  gen_random_uuid(),
  'Restaurante La Jefa',
  '+573009605506',
  ARRAY['corriente', 'comida casera'],
  '[
    {"item": "Bandeja Paisa", "price": 18000, "prep_min": 15, "available": true, "type": "diario"},
    {"item": "Sopa de Mondongo", "price": 15000, "prep_min": 10, "available": true, "type": "diario"}
  ]'::jsonb,
  'Sazón de hogar, la mejor comida casera',
  'Centro',
  false
);
