-- db/schema.sql
-- Esquema de Base de Datos para "En un 2x3"

-- Usuarios (clientes finales)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wa_phone VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(120),
    barrio VARCHAR(120),
    default_address TEXT,
    payment_pref VARCHAR(20),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Mensajeros / Conductores
CREATE TABLE couriers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wa_phone VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(120) NOT NULL,
    vehicle VARCHAR(10) NOT NULL, -- 'moto' | 'carro' | 'bici'
    plate VARCHAR(10),
    rating NUMERIC(2,1) DEFAULT 5.0,
    is_active BOOLEAN DEFAULT true
);

-- Comercios aliados
CREATE TABLE merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(120) NOT NULL,
    category VARCHAR(60)[],
    menu JSONB NOT NULL, -- [{item, price, prep_min, available}]
    specialty TEXT,
    commission_pct NUMERIC(4,2) DEFAULT 12.00,
    zone VARCHAR(60),
    lat NUMERIC(9,6),
    lng NUMERIC(9,6),
    sponsored BOOLEAN DEFAULT false,
    ad_plan VARCHAR(20), -- 'destacado' | 'estado' | 'premium'
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Órdenes (Domicilios, Paquetes, Viajes)
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(20) UNIQUE NOT NULL, -- e.g., 'FX-0042'
    type VARCHAR(12) NOT NULL, -- 'food' | 'package' | 'ride'
    user_id UUID REFERENCES users(id),
    merchant_id UUID REFERENCES merchants(id),
    courier_id UUID REFERENCES couriers(id),
    status VARCHAR(16) NOT NULL, -- DRAFT|CONFIRMED|PREPARING|PICKED_UP|ON_THE_WAY|DELIVERED|CANCELLED
    items JSONB,
    subtotal INT NOT NULL DEFAULT 0,
    delivery_fee INT NOT NULL DEFAULT 0,
    total INT NOT NULL DEFAULT 0,
    payment_method VARCHAR(10), -- 'cash' | 'transfer' | 'mixed'
    payment_status VARCHAR(12) DEFAULT 'PENDING', -- PENDING|VERIFIED|REVIEW
    cash_part INT DEFAULT 0,
    transfer_part INT DEFAULT 0,
    origin JSONB,
    destination JSONB,
    eta_minutes INT,
    created_at TIMESTAMPTZ DEFAULT now(),
    delivered_at TIMESTAMPTZ
);

-- Comprobantes de pago leídos por OCR
CREATE TABLE receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id),
    image_url TEXT,
    ocr_amount INT,
    ocr_date TIMESTAMPTZ,
    ocr_wallet VARCHAR(20), -- 'nequi', 'daviplata', 'breb'
    ocr_ref VARCHAR(40) UNIQUE,
    ocr_destination VARCHAR(30),
    match_ok BOOLEAN,
    raw_ocr JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Libro Mayor Contable (Ledger)
CREATE TABLE ledger (
    id BIGSERIAL PRIMARY KEY,
    order_id UUID REFERENCES orders(id),
    account VARCHAR(100) NOT NULL,
 -- 'caja_mensajero:ID' | 'banco_empresa' | 'cxc_comercio:ID' | 'ingreso_comision' | 'ingreso_domicilio' | 'cxp_mensajero:ID' | 'ingreso_publicidad'
    debit INT DEFAULT 0,
    credit INT DEFAULT 0,
    memo TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Liquidaciones Diarias de Mensajeros
CREATE TABLE settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    courier_id UUID REFERENCES couriers(id),
    date DATE NOT NULL,
    cash_collected INT DEFAULT 0,
    fees_earned INT DEFAULT 0,
    owed_to_company INT DEFAULT 0,
    owed_by_company INT DEFAULT 0,
    net INT DEFAULT 0,
    status VARCHAR(10) DEFAULT 'OPEN', -- OPEN|SETTLED
    UNIQUE(courier_id, date)
);

-- Contratos de Publicidad de Comercios
CREATE TABLE ad_contracts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_name VARCHAR(120) NOT NULL,
    plan VARCHAR(20) NOT NULL, -- 'destacado' | 'estado' | 'premium'
    price_monthly INT NOT NULL,
    status VARCHAR(10) DEFAULT 'ACTIVE', -- ACTIVE|CANCELLED
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Estados de WhatsApp Publicados
CREATE TABLE status_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    published_at TIMESTAMPTZ DEFAULT now(),
    merchants JSONB NOT NULL,
    views INT DEFAULT 0
);
