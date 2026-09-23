-- db/02-seed.sql
-- Mensajeros semilla activos en Fonseca

INSERT INTO couriers (wa_phone, name, vehicle, plate, rating, is_active)
VALUES 
    ('+573001112233', 'Carlos Mendoza', 'moto', 'XYZ-12F', 4.9, true),
    ('+573004445566', 'José Morales', 'moto', 'ABC-34D', 5.0, true),
    ('+573007778899', 'Luis Gómez', 'moto', 'KJH-89A', 4.8, true)
ON CONFLICT (wa_phone) DO NOTHING;
