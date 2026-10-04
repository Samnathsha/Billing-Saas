"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { passwordStrength, STRENGTH_TEXT } from "@/lib/password-strength";

// A password box with a Show button (ASVS 2.1.12) and, for a NEW password,
// a strength guide (ASVS 2.1.8). Pasting is allowed (password managers).
export function PasswordField(props: { id: string; label: string; autoComplete: string; minLength?: number; maxLength?: number }): ReactNode {
  const [shown, setShown] = useState(false);
  const [value, setValue] = useState("");
  const isNew = props.autoComplete === "new-password";
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <div className="flex gap-2">
        <Input
          id={props.id}
          name={props.id}
          type={shown ? "text" : "password"}
          autoComplete={props.autoComplete}
          required
          minLength={props.minLength}
          maxLength={props.maxLength}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
          }}
        />
        <Button type="button" variant="outline" size="sm" aria-pressed={shown} aria-controls={props.id} onClick={() => { setShown(!shown); }}>
          {shown ? "Hide" : "Show"}
        </Button>
      </div>
      {isNew && value !== "" ? (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          Strength: {STRENGTH_TEXT[passwordStrength(value, props.minLength ?? 12)]}
        </p>
      ) : null}
    </div>
  );
}
