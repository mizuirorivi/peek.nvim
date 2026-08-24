local unpack = unpack or table.unpack

return function(fn, timeout)
  local pending
  local generation = 0

  local self = {
    timer = nil,
    timeout = timeout,
  }

  local function stop_timer()
    if not self.timer then
      return
    end
    self.timer:stop()
    if not self.timer:is_closing() then
      self.timer:close()
    end
    self.timer = nil
  end

  local function arm()
    local current_generation = generation
    self.timer = vim.defer_fn(function()
      if current_generation ~= generation then
        return
      end
      self.timer = nil
      if not pending then
        return
      end

      local args = pending
      pending = nil
      fn(unpack(args))
      arm()
    end, self.timeout or 10)
  end

  function self:set_timeout(new_timeout)
    self.timeout = new_timeout
  end

  function self:clear()
    generation = generation + 1
    stop_timer()
    pending = nil
  end

  return setmetatable(self, {
    __call = function(_, ...)
      if self.timer then
        pending = { ... }
        return
      end

      fn(...)
      arm()
    end,
  })
end
